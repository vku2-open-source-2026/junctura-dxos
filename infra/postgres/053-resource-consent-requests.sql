-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

CREATE TABLE app_private.resource_consent_requests (
  tenant_id text NOT NULL,
  request_id uuid NOT NULL DEFAULT gen_random_uuid(),
  issuer text NOT NULL,
  subject_id text NOT NULL,
  login_subject text NOT NULL,
  requester text NOT NULL,
  recipient_unit text NOT NULL,
  resource_type text NOT NULL CHECK (resource_type IN ('record','object')),
  resource_id uuid NOT NULL,
  record_incarnation uuid NOT NULL,
  object_version uuid,
  purpose text NOT NULL CHECK (length(purpose) BETWEEN 1 AND 255 AND purpose !~ '[[:cntrl:]]'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','expired','cancelled')),
  decline_reason text CHECK (decline_reason IS NULL OR (status='declined'
    AND length(decline_reason) BETWEEN 1 AND 255 AND decline_reason !~ '[[:cntrl:]]')),
  unit_retired_at timestamptz,
  PRIMARY KEY (tenant_id,request_id),
  CHECK ((resource_type='object')=(object_version IS NOT NULL))
);
ALTER TABLE app_private.resource_consent_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.resource_consent_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY record_tenant_isolation ON app_private.resource_consent_requests TO junctura_app_owner
  USING (tenant_id=app_private.record_tenant()) WITH CHECK (tenant_id=app_private.record_tenant());
CREATE UNIQUE INDEX resource_consent_request_pending ON app_private.resource_consent_requests
  (tenant_id,recipient_unit,resource_type,resource_id,purpose) WHERE status='pending';
CREATE INDEX resource_consent_request_subject ON app_private.resource_consent_requests
  (tenant_id,issuer,login_subject,subject_id,created_at DESC,request_id DESC) WHERE status='pending';
CREATE INDEX resource_consent_request_recipient ON app_private.resource_consent_requests
  (tenant_id,recipient_unit) WHERE unit_retired_at IS NULL;

ALTER TABLE app_private.resource_consents ADD COLUMN request_id uuid,
  ADD FOREIGN KEY (tenant_id,request_id) REFERENCES app_private.resource_consent_requests (tenant_id,request_id);
CREATE UNIQUE INDEX resource_consent_request_grant ON app_private.resource_consents
  (tenant_id,request_id) WHERE request_id IS NOT NULL;

CREATE FUNCTION app_private.insert_resource_consent(p_tenant text,p_issuer text,p_subject text,p_login text,
  p_unit text,p_kind text,p_resource uuid,p_incarnation uuid,p_version uuid,p_purpose text,
  p_expires timestamptz,p_request uuid DEFAULT NULL) RETURNS app_private.resource_consents
LANGUAGE sql SET search_path=pg_catalog,app_private,pg_temp AS $$
  INSERT INTO resource_consents(tenant_id,issuer,subject_id,login_subject,recipient_unit,resource_type,resource_id,
    record_incarnation,object_version,purpose,expires_at,request_id)
  VALUES (p_tenant,p_issuer,p_subject,p_login,p_unit,p_kind,p_resource,p_incarnation,p_version,p_purpose,p_expires,p_request)
  RETURNING *
$$;

DO $migration$
DECLARE source text; updated text;
BEGIN
  source:=pg_get_functiondef('core.resource_consent_command(text,jsonb)'::regprocedure);
  updated:=replace(source,$old$  INSERT INTO resource_consents(tenant_id,issuer,subject_id,login_subject,recipient_unit,resource_type,resource_id,
    record_incarnation,object_version,purpose,expires_at)
  VALUES (tenant,iss,sid,who,unit_key,kind,resource,r.incarnation,o.version,purpose_text,expires) RETURNING * INTO s;$old$,
    $new$  s:=insert_resource_consent(tenant,iss,sid,who,unit_key,kind,resource,r.incarnation,o.version,purpose_text,expires);$new$);
  IF updated=source THEN RAISE EXCEPTION 'Unexpected resource consent command'; END IF;
  EXECUTE updated;
END $migration$;

CREATE OR REPLACE FUNCTION app_private.resource_consent_view(s app_private.resource_consents) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,app_private AS $$
  SELECT jsonb_build_object('consentId',s.consent_id,'resourceType',s.resource_type,'resourceId',s.resource_id,
    'recipientUnit',s.recipient_unit,'purpose',s.purpose,'createdAt',s.created_at,
    'expiresAt',s.expires_at,'revokedAt',s.revoked_at,
    'status',coalesce(replace(resource_consent_state(s,statement_timestamp()),'consent_',''),'active'))
    || jsonb_strip_nulls(jsonb_build_object('requestId',s.request_id))
$$;

CREATE FUNCTION app_private.resource_consent_request_view(s app_private.resource_consent_requests) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,app_private,pg_temp AS $$
  SELECT jsonb_build_object('requestId',s.request_id,'resourceType',s.resource_type,'resourceId',s.resource_id,
    'recipientUnit',s.recipient_unit,'purpose',s.purpose,'createdAt',s.created_at,'expiresAt',s.expires_at,
    'status',s.status,'declineReason',s.decline_reason,'consentId',
    (SELECT g.consent_id FROM resource_consents g WHERE (g.tenant_id,g.request_id)=(s.tenant_id,s.request_id)))
$$;

CREATE FUNCTION app_private.audit_resource_consent_request() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,app_private,pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM audit_append('audit.resource_consent_request_' || NEW.status,'audit',NEW.request_id,
      CASE WHEN TG_OP='INSERT' THEN 1 ELSE 2 END);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER audit_resource_consent_request AFTER INSERT OR UPDATE OF status ON app_private.resource_consent_requests
  FOR EACH ROW EXECUTE FUNCTION app_private.audit_resource_consent_request();

-- A reused directory unit key must not inherit requests from the retired unit.
CREATE FUNCTION app_private.retire_unit_consent_requests() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,app_private,pg_temp AS $$
DECLARE retired_at timestamptz := clock_timestamp();
BEGIN
  IF TG_OP='DELETE' OR (NEW.pending_delete AND NOT OLD.pending_delete) THEN
    UPDATE resource_consent_requests x SET unit_retired_at=retired_at,
      status=CASE WHEN x.status<>'pending' THEN x.status
        WHEN x.expires_at<=retired_at THEN 'expired' ELSE 'cancelled' END
      WHERE (x.tenant_id,x.recipient_unit)=(OLD.tenant_id,OLD.unit) AND x.unit_retired_at IS NULL;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER retire_unit_consent_requests AFTER UPDATE OF pending_delete OR DELETE ON app_private.directory_units
  FOR EACH ROW EXECUTE FUNCTION app_private.retire_unit_consent_requests();

CREATE FUNCTION core.resource_consent_request_command(operation text,payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private,pg_temp
SET lock_timeout='2s' SET timezone='UTC' AS $$
DECLARE
  c jsonb := current_setting('request.jwt.claims',true)::jsonb;
  tenant text := record_tenant();
  iss text := c->>'iss';
  who text := c->>'sub';
  sid text := c->>'subject_id';
  unit_key text := c->>'resource_unit';
  is_subject boolean := c->>'role'='junctura_subject_api';
  actor uuid;
  rid uuid := (payload->>'requestId')::uuid;
  kind text := payload->>'resourceType';
  resource uuid := (payload->>'resourceId')::uuid;
  purpose_text text := payload->>'purpose';
  reason_text text := payload->>'reason';
  expires timestamptz;
  recipient_active boolean;
  target record;
  r core.app_records;
  o resource_objects;
  s resource_consent_requests;
  result jsonb;
BEGIN
  IF is_subject THEN
    IF c ? 'actor_sub' OR NOT EXISTS (
      SELECT FROM subject_bindings b WHERE (b.tenant_id,b.issuer,b.login_subject,b.subject_id)=(tenant,iss,who,sid)
    ) THEN RETURN record_error(403,'verified_subject_required'); END IF;
    IF coalesce(operation,'') NOT IN ('list','accept','decline') THEN RETURN record_error(400,'invalid_operation'); END IF;
  ELSE
    actor:=core.resource_actor();
    IF c->>'role' IS DISTINCT FROM 'junctura_resource_api' OR actor IS NULL OR unit_key IS NULL
        OR c->>'actor_sub' IS NULL OR c->>'human_app_id' IS DISTINCT FROM actor::text OR NOT EXISTS (
          SELECT FROM enrollments e WHERE (e.tenant_id,e.issuer,e.oauth_client_id,e.resource_subject)=
            (tenant,iss,c->>'client_id',c->>'actor_sub') AND e.enabled
        ) THEN RETURN record_error(403,'application_access_required'); END IF;
    PERFORM 1 FROM directory_units u JOIN directory_members m USING (tenant_id,unit)
      WHERE (u.tenant_id,u.unit,m.subject)=(tenant,unit_key,who)
        AND NOT u.pending_delete AND u.confirmed_value IS NOT NULL
        AND NOT m.pending_delete AND m.confirmed_value IS NOT NULL FOR SHARE OF u,m;
    IF NOT FOUND THEN RETURN record_error(403,'not_assigned_to_app'); END IF;
    IF coalesce(operation,'') NOT IN ('create','get','cancel') THEN RETURN record_error(400,'invalid_operation'); END IF;
  END IF;

  IF operation='list' THEN
    UPDATE resource_consent_requests x SET status='expired'
      WHERE (x.tenant_id,x.issuer,x.login_subject,x.subject_id)=(tenant,iss,who,sid)
        AND x.status='pending' AND x.expires_at<=statement_timestamp();
    SELECT jsonb_build_object('requests',coalesce(jsonb_agg(resource_consent_request_view(x)
      ORDER BY x.created_at DESC,x.request_id DESC),'[]'::jsonb)) INTO result FROM resource_consent_requests x
      WHERE (x.tenant_id,x.issuer,x.login_subject,x.subject_id)=(tenant,iss,who,sid) AND x.status='pending';
    RETURN jsonb_build_object('status',200,'value',result);
  END IF;

  IF operation='create' THEN
    expires:=record_time('date-time',payload->>'expiresAt');
    IF expires IS NULL OR expires<=clock_timestamp() THEN RETURN record_error(400,'invalid_consent_expiry'); END IF;
    IF coalesce(kind,'') NOT IN ('record','object') OR resource IS NULL OR coalesce(length(purpose_text),0) NOT BETWEEN 1 AND 255
        OR purpose_text !~ '[^[:space:]]' OR purpose_text ~ '[[:cntrl:]]' THEN
      RETURN record_error(400,'invalid_consent_request');
    END IF;
    SELECT * INTO target FROM resource_consent_target(kind,resource,NULL);
    r:=target.record_row;
    o:=target.object_row;
    SELECT b.subject_id INTO sid FROM subject_bindings b
      JOIN applications a ON (a.tenant_id,a.issuer)=(b.tenant_id,b.issuer)
      WHERE (b.tenant_id,b.issuer,b.login_subject,a.app_id)=(tenant,iss,r.consent_subject,r.owner_app_id)
        AND resource_app_active(a.app_id);
    IF NOT FOUND THEN RETURN record_error(404,'not_found'); END IF;

    UPDATE resource_consent_requests x SET status='expired'
      WHERE (x.tenant_id,x.recipient_unit,x.resource_type,x.resource_id,x.purpose)=(tenant,unit_key,kind,resource,purpose_text)
        AND x.status='pending' AND x.expires_at<=clock_timestamp();
    IF expires<=clock_timestamp() THEN RETURN record_error(400,'invalid_consent_expiry'); END IF;
    INSERT INTO resource_consent_requests(tenant_id,issuer,subject_id,login_subject,requester,recipient_unit,
      resource_type,resource_id,record_incarnation,object_version,purpose,expires_at)
    VALUES (tenant,iss,sid,r.consent_subject,who,unit_key,kind,resource,r.incarnation,o.version,purpose_text,expires)
    ON CONFLICT (tenant_id,recipient_unit,resource_type,resource_id,purpose) WHERE status='pending' DO NOTHING
    RETURNING * INTO s;
    IF NOT FOUND THEN RETURN record_error(409,'consent_request_already_pending'); END IF;
    RETURN jsonb_build_object('status',201,'value',resource_consent_request_view(s));
  END IF;

  -- Match the directory retirement lock order before locking the request.
  IF operation='accept' THEN
    PERFORM 1 FROM resource_consent_requests x JOIN directory_units u
      ON (u.tenant_id,u.unit)=(x.tenant_id,x.recipient_unit)
      WHERE (x.tenant_id,x.issuer,x.login_subject,x.subject_id,x.request_id)=(tenant,iss,who,sid,rid)
        AND NOT u.pending_delete AND u.confirmed_value IS NOT NULL FOR SHARE OF u;
    recipient_active:=FOUND;
  END IF;
  SELECT x.* INTO s FROM resource_consent_requests x
    WHERE (x.tenant_id,x.issuer,x.request_id)=(tenant,iss,rid)
      AND CASE WHEN is_subject THEN (x.login_subject,x.subject_id)=(who,sid)
        ELSE (x.requester,x.recipient_unit)=(who,unit_key) AND x.unit_retired_at IS NULL END
    FOR UPDATE;
  IF NOT FOUND THEN RETURN record_error(404,'not_found'); END IF;

  IF operation='accept' AND s.status='pending' AND s.expires_at>clock_timestamp() AND recipient_active THEN
    SELECT * INTO target FROM resource_consent_target(s.resource_type,s.resource_id,NULL);
    r:=target.record_row;
    o:=target.object_row;
  END IF;
  IF s.status='pending' AND s.expires_at<=clock_timestamp() THEN
    UPDATE resource_consent_requests x SET status='expired'
      WHERE (x.tenant_id,x.request_id)=(tenant,rid) RETURNING * INTO s;
  END IF;
  IF operation='get' THEN RETURN jsonb_build_object('status',200,'value',resource_consent_request_view(s)); END IF;
  IF s.status<>'pending' THEN RETURN record_error(409,'consent_request_not_pending'); END IF;

  IF operation='accept' THEN
    IF NOT recipient_active OR r.incarnation IS DISTINCT FROM s.record_incarnation
        OR r.consent_subject IS DISTINCT FROM who OR o.version IS DISTINCT FROM s.object_version
        OR NOT resource_app_active(r.owner_app_id) THEN RETURN record_error(409,'consent_request_target_changed'); END IF;
    PERFORM insert_resource_consent(tenant,iss,sid,who,s.recipient_unit,s.resource_type,s.resource_id,
      s.record_incarnation,s.object_version,s.purpose,s.expires_at,rid);
  ELSIF operation='decline' AND reason_text IS NOT NULL AND (length(reason_text) NOT BETWEEN 1 AND 255
      OR reason_text !~ '[^[:space:]]' OR reason_text ~ '[[:cntrl:]]') THEN
    RETURN record_error(400,'invalid_consent_request');
  END IF;
  UPDATE resource_consent_requests x SET
    status=CASE operation WHEN 'accept' THEN 'accepted' WHEN 'decline' THEN 'declined' ELSE 'cancelled' END,
    decline_reason=CASE WHEN operation='decline' THEN reason_text END
    WHERE (x.tenant_id,x.request_id)=(tenant,rid) RETURNING * INTO s;
  RETURN jsonb_build_object('status',200,'value',resource_consent_request_view(s));
END $$;

REVOKE ALL ON app_private.resource_consent_requests FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.insert_resource_consent(text,text,text,text,text,text,uuid,uuid,uuid,text,timestamptz,uuid),
  app_private.resource_consent_request_view(app_private.resource_consent_requests),app_private.audit_resource_consent_request(),
  app_private.retire_unit_consent_requests(),core.resource_consent_request_command(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.resource_consent_request_command(text,jsonb) TO junctura_subject_api,junctura_resource_api;
RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (53);
NOTIFY pgrst,'reload schema';
COMMIT;
