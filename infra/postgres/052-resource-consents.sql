-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='junctura_consent_lookup') THEN
    CREATE ROLE junctura_consent_lookup NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA core,app_private TO junctura_consent_lookup;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

-- Human writes carry the application assignment verified by Core. Backend
-- writes and existing rows have no verified account to associate with consent.
ALTER TABLE core.app_records ADD COLUMN consent_subject text;
ALTER TABLE core.app_records ALTER COLUMN consent_subject SET DEFAULT (
  CASE WHEN nullif(current_setting('request.jwt.claims',true),'')::jsonb ? 'human_app_id'
    THEN current_setting('request.jwt.claims',true)::jsonb->>'sub' END);

CREATE TABLE app_private.resource_consents (
  tenant_id text NOT NULL,
  consent_id uuid NOT NULL DEFAULT gen_random_uuid(),
  issuer text NOT NULL,
  subject_id text NOT NULL,
  login_subject text NOT NULL,
  recipient_unit text NOT NULL,
  resource_type text NOT NULL CHECK (resource_type IN ('record','object')),
  resource_id uuid NOT NULL,
  record_incarnation uuid NOT NULL,
  object_version uuid,
  purpose text NOT NULL CHECK (length(purpose) BETWEEN 1 AND 255 AND purpose !~ '[[:cntrl:]]'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz,
  revoked_at timestamptz,
  unit_retired_at timestamptz,
  PRIMARY KEY (tenant_id, consent_id),
  CHECK ((resource_type='object')=(object_version IS NOT NULL))
);
ALTER TABLE app_private.resource_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.resource_consents FORCE ROW LEVEL SECURITY;
CREATE POLICY record_tenant_isolation ON app_private.resource_consents TO junctura_app_owner
  USING (tenant_id=app_private.record_tenant())
  WITH CHECK (tenant_id=app_private.record_tenant());
CREATE INDEX resource_consent_lookup ON app_private.resource_consents
  (tenant_id,recipient_unit,resource_type,resource_id,record_incarnation);
CREATE INDEX resource_consent_subject ON app_private.resource_consents
  (tenant_id,issuer,login_subject,subject_id,created_at DESC,consent_id DESC);

-- Deletion retires grants to the directory unit, even if its key is reused.
CREATE FUNCTION app_private.retire_unit_consents() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,app_private,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.pending_delete AND NOT OLD.pending_delete) THEN
    UPDATE resource_consents SET unit_retired_at=clock_timestamp()
      WHERE tenant_id=OLD.tenant_id AND recipient_unit=OLD.unit AND unit_retired_at IS NULL;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER retire_unit_consents AFTER UPDATE OF pending_delete OR DELETE ON app_private.directory_units
  FOR EACH ROW EXECUTE FUNCTION app_private.retire_unit_consents();

-- The private lookup role can lock targets within the request tenant.
-- FOR SHARE needs UPDATE on one column, so deny writes in the policies.
GRANT SELECT, UPDATE (id) ON core.app_records,app_private.resource_objects TO junctura_consent_lookup;
GRANT EXECUTE ON FUNCTION app_private.record_tenant() TO junctura_consent_lookup;
CREATE POLICY consent_lookup_tenant ON core.app_records TO junctura_consent_lookup
  USING (tenant_id=app_private.record_tenant()) WITH CHECK (false);
CREATE POLICY consent_lookup_tenant ON app_private.resource_objects TO junctura_consent_lookup
  USING (tenant_id=app_private.record_tenant()) WITH CHECK (false);

ALTER POLICY record_unit_isolation ON core.app_records USING (
  resource_unit IS NOT DISTINCT FROM (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'resource_unit')
  OR current_setting('request.jwt.claims',true)::jsonb->>'role' IN ('junctura_search_worker','junctura_app_access_api')
  OR current_user='junctura_consent_lookup');
ALTER POLICY object_unit_isolation ON app_private.resource_objects USING (
  resource_unit IS NOT DISTINCT FROM (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'resource_unit')
  OR current_setting('request.jwt.claims',true)::jsonb->>'role' IN ('junctura_search_worker','junctura_objects_worker','junctura_app_access_api')
  OR current_user='junctura_consent_lookup');

CREATE FUNCTION app_private.resource_consent_target(p_kind text,p_id uuid,p_collection text)
RETURNS TABLE(record_row core.app_records,object_row app_private.resource_objects)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private,pg_temp AS $$
DECLARE
  tenant text := record_tenant();
  r core.app_records;
  o resource_objects;
BEGIN
  IF p_kind='record' THEN
    SELECT * INTO r FROM core.app_records WHERE tenant_id=tenant AND id=p_id
      AND (p_collection IS NULL OR collection=p_collection) FOR SHARE;
  ELSIF p_kind='object' THEN
    SELECT * INTO o FROM resource_objects WHERE tenant_id=tenant AND id=p_id FOR SHARE;
    IF NOT o.deleted AND o.version IS NOT NULL AND o.record_id IS NOT NULL THEN
      SELECT * INTO r FROM core.app_records WHERE tenant_id=tenant AND id=o.record_id
        AND collection=o.record_collection AND incarnation=o.record_incarnation
        AND owner_app_id=o.owner_app_id AND resource_unit IS NOT DISTINCT FROM o.resource_unit FOR SHARE;
    END IF;
  END IF;
  RETURN QUERY SELECT r,o;
END $$;

CREATE FUNCTION app_private.resource_consent_state(p_consent app_private.resource_consents,p_now timestamptz)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN p_consent.consent_id IS NULL THEN 'consent_required'
    WHEN p_consent.revoked_at IS NOT NULL THEN 'consent_revoked'
    WHEN p_consent.expires_at<=p_now THEN 'consent_expired'
    WHEN p_consent.unit_retired_at IS NOT NULL THEN 'consent_inactive' END
$$;

CREATE FUNCTION app_private.resource_consent_view(s app_private.resource_consents) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,app_private AS $$
  SELECT jsonb_build_object('consentId',s.consent_id,'resourceType',s.resource_type,'resourceId',s.resource_id,
    'recipientUnit',s.recipient_unit,'purpose',s.purpose,'createdAt',s.created_at,
    'expiresAt',s.expires_at,'revokedAt',s.revoked_at,
    'status',coalesce(replace(resource_consent_state(s,statement_timestamp()),'consent_',''),'active'))
$$;

CREATE FUNCTION core.resource_consent_command(operation text,payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private,pg_temp
SET lock_timeout='2s' SET timezone='UTC' AS $$
DECLARE
  c jsonb := current_setting('request.jwt.claims',true)::jsonb;
  tenant text := record_tenant();
  who text := c->>'sub';
  iss text := c->>'iss';
  sid text := c->>'subject_id';
  path constant text := '/v1/me/resource-consents';
  s resource_consents;
  target record;
  r core.app_records;
  o resource_objects;
  body jsonb := payload->'consent';
  kind text := body->>'resourceType';
  unit_key text := body->>'recipientUnit';
  purpose_text text := body->>'purpose';
  expires timestamptz;
  resource uuid;
  request_key uuid;
  request_digest bytea;
  scope bytea;
  result jsonb;
BEGIN
  IF NOT EXISTS (SELECT FROM subject_bindings b WHERE (b.tenant_id,b.issuer,b.login_subject,b.subject_id)=(tenant,iss,who,sid)) THEN
    RETURN record_error(403,'verified_subject_required');
  END IF;
  IF operation='list' THEN
    SELECT jsonb_build_object('consents',coalesce(jsonb_agg(resource_consent_view(x) ORDER BY x.created_at DESC,x.consent_id DESC),'[]'::jsonb))
      INTO result FROM resource_consents x
      WHERE (x.tenant_id,x.issuer,x.login_subject,x.subject_id)=(tenant,iss,who,sid);
    RETURN jsonb_build_object('status',200,'value',result);
  ELSIF operation='revoke' THEN
    SELECT * INTO s FROM resource_consents x WHERE (x.tenant_id,x.issuer,x.login_subject,x.subject_id,x.consent_id)=
      (tenant,iss,who,sid,(payload->>'consentId')::uuid) FOR UPDATE;
    IF NOT FOUND THEN RETURN record_error(404,'not_found'); END IF;
    IF s.revoked_at IS NULL THEN
      UPDATE resource_consents x SET revoked_at=clock_timestamp()
        WHERE (x.tenant_id,x.consent_id)=(tenant,s.consent_id) RETURNING * INTO s;
    END IF;
    RETURN jsonb_build_object('status',200,'value',resource_consent_view(s));
  ELSIF operation IS DISTINCT FROM 'create' THEN
    RETURN record_error(400,'invalid_operation');
  END IF;

  IF coalesce(kind,'') NOT IN ('record','object') OR coalesce(unit_key,'') !~ '^[a-z][a-z0-9-]{1,63}$'
     OR coalesce(length(purpose_text),0) NOT BETWEEN 1 AND 255 OR purpose_text !~ '[^[:space:]]' OR purpose_text ~ '[[:cntrl:]]'
     OR coalesce(payload->>'digest','') !~ '^[0-9a-f]{64}$' OR payload->>'key' IS NULL OR body->>'resourceId' IS NULL THEN
    RETURN record_error(400,'invalid_consent');
  END IF;
  resource:=(body->>'resourceId')::uuid;
  request_key:=(payload->>'key')::uuid;
  request_digest:=decode(payload->>'digest','hex');
  scope:=record_caller_scope(NULL);
  result:=record_replay(scope,'POST',path,request_key,request_digest);
  IF result IS NOT NULL THEN RETURN result; END IF;

  IF body ? 'expiresAt' THEN
    expires:=record_time('date-time',body->>'expiresAt');
    IF expires IS NULL OR expires<=clock_timestamp() THEN RETURN record_error(400,'invalid_consent_expiry'); END IF;
  END IF;
  PERFORM 1 FROM directory_units u WHERE (u.tenant_id,u.unit)=(tenant,unit_key)
    AND NOT u.pending_delete AND u.confirmed_value IS NOT NULL FOR SHARE;
  IF NOT FOUND THEN RETURN record_error(404,'not_found'); END IF;
  SELECT * INTO target FROM resource_consent_target(kind,resource,NULL);
  r:=target.record_row;
  o:=target.object_row;
  -- The application's issuer is the issuer under which Core accepted the write.
  IF r.id IS NULL OR r.consent_subject IS DISTINCT FROM who OR NOT EXISTS (
    SELECT FROM applications a WHERE (a.tenant_id,a.app_id,a.issuer)=(tenant,r.owner_app_id,iss)
  ) THEN RETURN record_error(404,'not_found'); END IF;
  INSERT INTO resource_consents(tenant_id,issuer,subject_id,login_subject,recipient_unit,resource_type,resource_id,
    record_incarnation,object_version,purpose,expires_at)
  VALUES (tenant,iss,sid,who,unit_key,kind,resource,r.incarnation,o.version,purpose_text,expires) RETURNING * INTO s;
  result:=jsonb_build_object('status',201,'value',resource_consent_view(s));
  PERFORM record_save_replay(scope,'POST',path,request_key,request_digest,result);
  RETURN result;
END $$;

ALTER TABLE app_private.audit DROP CONSTRAINT audit_schema_version_check;
ALTER TABLE app_private.audit ADD CONSTRAINT audit_schema_version_check CHECK (
  (schema_version=2 AND event IN ('audit.application_event','audit.resource_consent_access')) OR
  (schema_version=1 AND event NOT IN ('audit.application_event','audit.resource_consent_access')));

DO $migration$
DECLARE source text; updated text;
BEGIN
  source:=pg_get_functiondef('app_private.audit_guard()'::regprocedure);
  updated:=replace(source,$old$  ELSIF c->>'role'='junctura_app_access_api'$old$,$new$  ELSIF NEW.event='audit.resource_consent_access' THEN
    actor:=core.resource_actor();
    IF c->>'role' IS DISTINCT FROM 'junctura_resource_api' OR c->>'actor_sub' IS NULL OR actor IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='delegated resource audit actor required';
    END IF;
  ELSIF c->>'role'='junctura_app_access_api'$new$);
  updated:=replace(updated, $old$WHEN NEW.event='audit.application_event' THEN 2$old$,
    $new$WHEN NEW.event IN ('audit.application_event','audit.resource_consent_access') THEN 2$new$);
  IF updated=source OR position('delegated resource audit actor required' IN updated)=0
    OR position($new$WHEN NEW.event IN ('audit.application_event','audit.resource_consent_access') THEN 2$new$ IN updated)=0 THEN
    RAISE EXCEPTION 'Unexpected audit guard';
  END IF;
  EXECUTE updated;

  source:=pg_get_functiondef('app_private.audit_projection(app_private.audit,jsonb,jsonb)'::regprocedure);
  updated:=replace(source,$old$  SELECT CASE WHEN a.schema_version=1 THEN$old$,$new$  SELECT CASE
  WHEN a.event='audit.resource_consent_access' THEN jsonb_build_object(
    'source','resource_consent','eventId',a.event_id,'appId',a.actor_app_id,'occurredAt',a.occurred_at,
    'tenantId',a.tenant_id,'managementClient',a.management_client) || (p_entry - ARRAY['sensitivity','purpose'])
  WHEN a.schema_version=1 THEN$new$);
  IF updated=source THEN RAISE EXCEPTION 'Unexpected audit projection'; END IF;
  EXECUTE updated;

  source:=pg_get_functiondef('core.subject_access_command(text,jsonb)'::regprocedure);
  updated:=replace(source,$old$'action', s.action, 'outcome', s.outcome) AS entry,$old$,
    $new$'action', s.action, 'outcome', s.outcome) ||
            CASE WHEN a.event='audit.resource_consent_access'
              THEN a.payload - ARRAY['subjectId','sensitivity','action','outcome','purpose']
              ELSE '{}'::jsonb END AS entry,$new$);
  IF updated=source THEN RAISE EXCEPTION 'Unexpected subject access projection'; END IF;
  source:=updated;
  updated:=replace(source,$old$FROM app_private.audit_subject_entries(sid) s
        LEFT JOIN$old$,$new$FROM app_private.audit_subject_entries(sid) s
        LEFT JOIN LATERAL (
          SELECT e.event,p.entry AS payload FROM app_private.audit e
          JOIN app_private.audit_app_payloads p USING (tenant_id,event_id)
          WHERE e.tenant_id=tenant AND e.event_id=s.event_id AND e.event='audit.resource_consent_access'
        ) a ON true
        LEFT JOIN$new$);
  IF updated=source THEN RAISE EXCEPTION 'Unexpected subject access source'; END IF;
  EXECUTE updated;
END $migration$;

CREATE FUNCTION core.resource_consent_read(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private,pg_temp
SET lock_timeout='2s' SET timezone='UTC' AS $$
DECLARE
  c jsonb := current_setting('request.jwt.claims',true)::jsonb;
  tenant text := record_tenant();
  unit_key text := c->>'resource_unit';
  reader text := c->>'sub';
  actor uuid := core.resource_actor();
  kind text := payload->>'kind';
  resource uuid := (payload->>'id')::uuid;
  request_id uuid := (payload->>'requestId')::uuid;
  expected_version uuid := (payload->>'expectedVersion')::uuid;
  target record;
  r core.app_records;
  o resource_objects;
  s resource_consents;
  code text;
  outcome text;
  access_event uuid;
BEGIN
  IF actor IS NULL OR c->>'actor_sub' IS NULL OR c->>'human_app_id' IS DISTINCT FROM actor::text
      OR unit_key IS NULL OR NOT EXISTS (
        SELECT FROM enrollments e WHERE (e.tenant_id,e.issuer,e.oauth_client_id,e.resource_subject)=
          (tenant,c->>'iss',c->>'client_id',c->>'actor_sub') AND e.enabled
      ) THEN RETURN record_error(403,'application_access_required'); END IF;
  IF resource IS NULL OR request_id IS NULL OR
     (kind IS DISTINCT FROM 'object' AND (kind IS DISTINCT FROM 'record' OR payload->>'collection' IS NULL)) THEN
    RETURN record_error(400,'invalid_request');
  END IF;
  PERFORM 1 FROM directory_units u JOIN directory_members m USING (tenant_id,unit)
    WHERE (u.tenant_id,u.unit,m.subject)=(tenant,unit_key,reader)
      AND NOT u.pending_delete AND u.confirmed_value IS NOT NULL
      AND NOT m.pending_delete AND m.confirmed_value IS NOT NULL FOR SHARE OF u,m;
  IF NOT FOUND THEN
    PERFORM core.record_app_denial(jsonb_build_object('requestId',request_id,'code','not_assigned_to_app'));
    RETURN record_error(403,'not_assigned_to_app');
  END IF;

  SELECT * INTO target FROM resource_consent_target(kind,resource,payload->>'collection');
  r:=target.record_row;
  o:=target.object_row;
  IF r.consent_subject IS NOT NULL AND resource_app_active(r.owner_app_id) THEN
    WITH candidates AS MATERIALIZED (
      SELECT g AS grant_row FROM resource_consents g JOIN subject_bindings b
        ON (b.tenant_id,b.issuer,b.login_subject,b.subject_id)=(g.tenant_id,g.issuer,g.login_subject,g.subject_id)
      WHERE (g.tenant_id,g.issuer,g.login_subject,g.recipient_unit,g.resource_type,g.resource_id,g.record_incarnation)=
        (tenant,c->>'iss',r.consent_subject,unit_key,kind,resource,r.incarnation)
        AND g.object_version IS NOT DISTINCT FROM o.version AND g.unit_retired_at IS NULL
      FOR SHARE OF g
    )
    SELECT (g.grant_row).* INTO s FROM candidates g
      ORDER BY (resource_consent_state(g.grant_row,clock_timestamp()) IS NULL) DESC,
        (g.grant_row).created_at DESC,(g.grant_row).consent_id DESC LIMIT 1;
  END IF;
  code:=resource_consent_state(s,clock_timestamp());
  IF code='consent_required' THEN
    IF (kind='record' AND r.owner_app_id=actor AND r.resource_unit IS DISTINCT FROM unit_key)
       OR (kind='object' AND o.owner_app_id=actor AND o.resource_unit IS DISTINCT FROM unit_key) THEN
      PERFORM core.record_app_denial(jsonb_build_object('requestId',request_id,'code','unit_mismatch'));
      RETURN record_error(403,'unit_mismatch');
    END IF;
    RETURN record_error(404,'not_found');
  END IF;
  IF code IS NULL AND expected_version IS NOT NULL AND expected_version IS DISTINCT FROM o.version THEN
    RETURN record_error(404,'not_found');
  END IF;

  -- A download is counted at the final recheck, just before Core sends bytes.
  IF code IS NOT NULL OR kind='record' OR expected_version IS NOT NULL THEN
    outcome:=CASE WHEN code IS NULL THEN 'success' ELSE 'denied' END;
    PERFORM pg_advisory_xact_lock(hashtextextended('junctura.audit_chain:' || tenant,0));
    access_event:=audit_append('audit.resource_consent_access','audit',resource,0,outcome,code,request_id::text);
    INSERT INTO audit_app_payloads(tenant_id,event_id,entry,visible_to_subject)
    VALUES (tenant,access_event,jsonb_build_object(
      'subjectId',s.subject_id,'reader',reader,'unit',unit_key,'consentId',s.consent_id,
      'requestId',request_id,'reasonCode',code,'action','resource.read',
      'resourceRef',jsonb_strip_nulls(jsonb_build_object('type',kind,'id',resource,
        'collection',CASE WHEN kind='record' THEN r.collection END)),'purpose',s.purpose,
      'outcome',outcome,'sensitivity','standard'),true);
    PERFORM audit_seal_pending();
  END IF;
  IF code IS NOT NULL THEN RETURN record_error(403,code); END IF;
  IF kind='record' THEN RETURN record_response(200,r,'shared'); END IF;
  RETURN jsonb_build_object('status',200,'value',jsonb_build_object('ownerAppId',o.owner_app_id,'version',o.version));
END $$;

REVOKE ALL ON app_private.resource_consents FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.retire_unit_consents(),app_private.resource_consent_target(text,uuid,text),
  app_private.resource_consent_state(app_private.resource_consents,timestamptz),
  app_private.resource_consent_view(app_private.resource_consents),
  core.resource_consent_command(text,jsonb),core.resource_consent_read(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.resource_consent_command(text,jsonb) TO junctura_subject_api;
GRANT EXECUTE ON FUNCTION core.resource_consent_read(jsonb) TO junctura_resource_api;
RESET ROLE;
ALTER FUNCTION app_private.resource_consent_target(text,uuid,text) OWNER TO junctura_consent_lookup;
GRANT EXECUTE ON FUNCTION app_private.resource_consent_target(text,uuid,text) TO junctura_app_owner;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (52);
NOTIFY pgrst,'reload schema';
COMMIT;
