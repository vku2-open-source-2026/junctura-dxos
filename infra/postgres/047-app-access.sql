-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='junctura_app_access_api') THEN
    CREATE ROLE junctura_app_access_api NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT junctura_app_access_api TO junctura_data;
GRANT USAGE ON SCHEMA core TO junctura_app_access_api;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

ALTER TABLE app_private.applications ADD COLUMN owner_unit text,
  ADD COLUMN deployment_units text[] NOT NULL DEFAULT '{}',
  ADD COLUMN provider_ready boolean NOT NULL DEFAULT false;
CREATE POLICY app_provider_discovery ON app_private.applications FOR SELECT TO junctura_app_owner
  USING (current_setting('request.jwt.claims',true)::jsonb->>'app_sync_worker'='true'
    AND app_private.record_tenant() IS NULL);

CREATE TABLE app_private.app_assignments (
  tenant_id text NOT NULL,
  app_id uuid NOT NULL,
  assignment_id uuid NOT NULL DEFAULT gen_random_uuid(),
  unit text NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('unit','group','subject')),
  target text NOT NULL,
  app_role text NOT NULL CHECK (app_role IN ('viewer','editor','manager')),
  enabled boolean NOT NULL DEFAULT true,
  synchronized boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id,app_id,assignment_id),
  UNIQUE (tenant_id,app_id,unit,target_type,target,app_role),
  FOREIGN KEY (tenant_id,app_id) REFERENCES app_private.applications(tenant_id,app_id) ON DELETE CASCADE
);

ALTER TABLE app_private.app_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.app_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app_private.app_assignments TO junctura_app_owner
  USING (tenant_id=app_private.record_tenant()) WITH CHECK (tenant_id=app_private.record_tenant());

CREATE POLICY app_assignment_discovery ON app_private.app_assignments FOR SELECT TO junctura_app_owner
  USING (current_setting('request.jwt.claims',true)::jsonb->>'app_sync_worker'='true'
    AND app_private.record_tenant() IS NULL);

-- Directory tombstones remove both the current grant and its provider mapping.
CREATE FUNCTION app_private.invalidate_app_assignments() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private,pg_temp AS $$
DECLARE row_key jsonb := to_jsonb(NEW);
BEGIN
  UPDATE app_assignments s SET enabled=false,synchronized=false
    WHERE s.tenant_id=NEW.tenant_id AND s.enabled AND (
      TG_TABLE_NAME='applications' AND s.app_id=(row_key->>'app_id')::uuid
      OR s.unit=row_key->>'unit' AND (
        TG_TABLE_NAME='directory_units'
        OR TG_TABLE_NAME='directory_groups' AND s.target_type='group' AND s.target=row_key->>'unit_group'
        OR TG_TABLE_NAME='directory_members' AND s.target_type='subject' AND s.target=row_key->>'subject'
      )
    );
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.invalidate_app_assignments() FROM PUBLIC;
CREATE TRIGGER revoke_unit_assignments AFTER UPDATE OF pending_delete ON app_private.directory_units
  FOR EACH ROW WHEN (NEW.pending_delete AND NOT OLD.pending_delete) EXECUTE FUNCTION app_private.invalidate_app_assignments();
CREATE TRIGGER revoke_group_assignments AFTER UPDATE OF pending_delete ON app_private.directory_groups
  FOR EACH ROW WHEN (NEW.pending_delete AND NOT OLD.pending_delete) EXECUTE FUNCTION app_private.invalidate_app_assignments();
CREATE TRIGGER revoke_subject_assignments AFTER UPDATE OF pending_delete ON app_private.directory_members
  FOR EACH ROW WHEN (NEW.pending_delete AND NOT OLD.pending_delete) EXECUTE FUNCTION app_private.invalidate_app_assignments();
CREATE TRIGGER revoke_application_assignments AFTER UPDATE OF state ON app_private.applications
  FOR EACH ROW WHEN (NEW.state='revoked' AND OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION app_private.invalidate_app_assignments();

CREATE OR REPLACE FUNCTION app_private.application_view(a app_private.applications) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('appId',a.app_id,'tenantId',a.tenant_id,'displayName',a.display_name,
    'oauthClientId',a.oauth_client_id,'providerOrigin',a.provider_origin,'state',a.state,
    'ownerSubject',a.owner_subject,'revision',a.revision,'digest',a.digest,
    'ownerUnit',a.owner_unit,'deploymentUnits',a.deployment_units)
$$;

CREATE FUNCTION app_private.assignment_view(x app_private.app_assignments) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('assignmentId',x.assignment_id,'unit',x.unit,'targetType',x.target_type,
    'target',x.target,'role',x.app_role,'enabled',x.enabled,'synchronized',x.synchronized)
$$;

CREATE TABLE app_private.app_sync_leases (
  tenant_id text NOT NULL, app_id uuid NOT NULL, lease_id uuid NOT NULL, expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,app_id),
  FOREIGN KEY (tenant_id,app_id) REFERENCES app_private.applications(tenant_id,app_id) ON DELETE CASCADE
);
ALTER TABLE app_private.app_sync_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.app_sync_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app_private.app_sync_leases TO junctura_app_owner
  USING (tenant_id=app_private.record_tenant()) WITH CHECK (tenant_id=app_private.record_tenant());

CREATE TABLE app_private.app_oidc_rotations (
  tenant_id text NOT NULL, app_id uuid NOT NULL, rotation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), applied_at timestamptz,
  PRIMARY KEY (tenant_id,app_id,rotation_id),
  FOREIGN KEY (tenant_id,app_id) REFERENCES app_private.applications(tenant_id,app_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX app_oidc_one_pending ON app_private.app_oidc_rotations (tenant_id,app_id) WHERE applied_at IS NULL;
ALTER TABLE app_private.app_oidc_rotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.app_oidc_rotations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app_private.app_oidc_rotations TO junctura_app_owner
  USING (tenant_id=app_private.record_tenant()) WITH CHECK (tenant_id=app_private.record_tenant());

CREATE FUNCTION core.application_management(operation text,payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private,pg_temp AS $$
DECLARE
  c jsonb := current_setting('request.jwt.claims',true)::jsonb;
  tenant text := c->>'tenant_id'; who text := c->>'sub'; iss text := c->>'iss'; client text := c->>'client_id';
  perms text[]; console_role text := c->>'console_role';
  worker boolean := coalesce(c->>'app_sync_worker'='true',false);
  manage boolean; browse boolean; a applications; x app_assignments;
  items jsonb; rotation app_oidc_rotations; page_size integer; next_id uuid; units text[]; owner text; label text; assignee text; event_name text;
BEGIN
  IF worker AND operation='sync_apps' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('tenantId',j.tenant_id,'appId',j.app_id)
        ORDER BY j.tenant_id,j.app_id),'[]'::jsonb) INTO items
      FROM (SELECT v.tenant_id,v.app_id FROM applications v WHERE NOT v.provider_ready AND v.state<>'revoked'
        AND (v.tenant_id,v.app_id)>(coalesce(payload->>'tenantId',''),
          coalesce((payload->>'appId')::uuid,'00000000-0000-0000-0000-000000000000'))
        ORDER BY v.tenant_id,v.app_id LIMIT 50) j;
    RETURN jsonb_build_object('status',200,'value',items);
  END IF;
  IF worker AND operation='sync_queue' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('tenantId',j.tenant_id,'appId',j.app_id,'assignmentId',j.assignment_id)
        ORDER BY j.tenant_id,j.app_id,j.assignment_id),'[]'::jsonb)
      INTO items FROM (SELECT s.tenant_id,s.app_id,s.assignment_id FROM app_assignments s
        WHERE NOT s.synchronized AND (s.tenant_id,s.app_id,s.assignment_id)>
          (coalesce(payload->>'tenantId',''),coalesce((payload->>'appId')::uuid,'00000000-0000-0000-0000-000000000000'),
           coalesce((payload->>'assignmentId')::uuid,'00000000-0000-0000-0000-000000000000'))
        ORDER BY s.tenant_id,s.app_id,s.assignment_id LIMIT 50) j;
    RETURN jsonb_build_object('status',200,'value',items);
  END IF;
  IF worker AND operation NOT IN ('lease','release','provider_confirm','assignment_sync','assignment_confirm') THEN
    RETURN jsonb_build_object('status',403,'error','application_permission_required');
  END IF;
  SELECT p.permissions INTO perms FROM principals p
    WHERE (p.tenant_id,p.issuer,p.subject,p.management_client)=(tenant,iss,who,client) AND p.enabled;
  manage := worker OR coalesce('applications.approve'=ANY(perms),false) OR coalesce(console_role IN ('admin','manager'),false);
  browse := manage OR coalesce(console_role='viewer' OR 'audit.read'=ANY(perms),false);

  IF operation='list' THEN
    IF NOT browse AND perms IS NULL THEN RETURN jsonb_build_object('status',403,'error','application_permission_required'); END IF;
    page_size := (payload->>'limit')::integer;
    WITH page AS (
      SELECT v AS app,v.app_id FROM applications v WHERE v.tenant_id=tenant AND v.issuer=iss
        AND (browse OR v.owner_subject=who)
        AND (NOT payload ? 'state' OR v.state=payload->>'state')
        AND (NOT payload ? 'unit' OR payload->>'unit'=ANY(v.deployment_units))
        AND (NOT payload ? 'q' OR strpos(lower(v.display_name),lower(payload->>'q'))>0)
        AND (NOT payload ? 'after' OR v.app_id>(payload->>'after')::uuid)
      ORDER BY v.app_id LIMIT page_size+1
    ), numbered AS (SELECT app,app_id,row_number() OVER (ORDER BY app_id) AS n FROM page)
    SELECT coalesce(jsonb_agg(application_view(app) ORDER BY n) FILTER (WHERE n<=page_size),'[]'::jsonb),
      CASE WHEN count(*)>page_size THEN (array_agg(app_id) FILTER (WHERE n=page_size))[1] END
      INTO items,next_id FROM numbered;
    RETURN jsonb_build_object('status',200,'value',jsonb_build_object('items',items,'nextCursor',next_id));
  END IF;

  SELECT v.* INTO a FROM applications v WHERE v.tenant_id=tenant AND v.issuer=iss
    AND v.app_id=(payload->>'appId')::uuid FOR UPDATE;
  IF NOT FOUND OR NOT (browse OR (perms IS NOT NULL AND a.owner_subject=who)) THEN
    RETURN jsonb_build_object('status',404,'error','not_found');
  END IF;
  IF operation='get' THEN RETURN jsonb_build_object('status',200,'value',application_view(a)); END IF;
  IF operation='assignments' THEN
    SELECT coalesce(jsonb_agg(assignment_view(s) ORDER BY s.unit,s.target_type,s.target,s.app_role),'[]'::jsonb) INTO items
      FROM app_assignments s WHERE s.tenant_id=tenant AND s.app_id=a.app_id AND (s.enabled OR NOT s.synchronized);
    RETURN jsonb_build_object('status',200,'value',jsonb_build_object('items',items));
  END IF;
  IF NOT manage AND NOT coalesce('applications.register'=ANY(perms) AND a.owner_subject=who,false) THEN
    RETURN jsonb_build_object('status',403,'error','application_permission_required');
  END IF;
  IF operation='rotation_history' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('rotationId',r.rotation_id,
      'createdAt',r.created_at,'appliedAt',r.applied_at) ORDER BY r.created_at DESC,r.rotation_id DESC),'[]'::jsonb)
      INTO items FROM (SELECT * FROM app_oidc_rotations z WHERE z.tenant_id=tenant AND z.app_id=a.app_id
        ORDER BY z.created_at DESC,z.rotation_id DESC LIMIT 100) r;
    RETURN jsonb_build_object('status',200,'value',jsonb_build_object('items',items));
  END IF;
  IF a.state='revoked' AND operation IN ('update','rotation_start','assignment_put') THEN RETURN jsonb_build_object('status',409,'error','invalid_transition'); END IF;

  IF operation='update' THEN
    IF payload->>'etag' IS NULL THEN RETURN jsonb_build_object('status',428,'error','if_match_required'); END IF;
    IF payload->>'etag'<>('"'||'application-'||a.app_id||'-'||a.revision||'"') THEN
      RETURN jsonb_build_object('status',412,'error','revision_mismatch');
    END IF;
    label := coalesce(payload->>'displayName',a.display_name);
    owner := CASE WHEN payload ? 'ownerUnit' THEN payload->>'ownerUnit' ELSE a.owner_unit END;
    units := CASE WHEN payload ? 'deploymentUnits' THEN
      ARRAY(SELECT d.unit_key FROM jsonb_array_elements_text(payload->'deploymentUnits') AS d(unit_key)
        ORDER BY d.unit_key COLLATE "C")
      ELSE a.deployment_units END;
    IF cardinality(units)>0 AND owner IS NULL THEN RETURN jsonb_build_object('status',400,'error','invalid_application_body'); END IF;
    IF (owner IS NOT NULL AND NOT EXISTS (SELECT FROM directory_units d WHERE d.tenant_id=tenant AND d.unit=owner AND NOT d.pending_delete AND d.confirmed_value IS NOT NULL))
      OR EXISTS (SELECT FROM unnest(units) AS u(unit_key) WHERE NOT EXISTS (
        SELECT FROM directory_units d WHERE d.tenant_id=tenant AND d.unit=u.unit_key AND NOT d.pending_delete AND d.confirmed_value IS NOT NULL)) THEN
      RETURN jsonb_build_object('status',404,'error','not_found');
    END IF;
    IF EXISTS (SELECT FROM app_assignments s WHERE s.tenant_id=tenant AND s.app_id=a.app_id AND s.enabled AND NOT (s.unit=ANY(units))) THEN
      RETURN jsonb_build_object('status',409,'error','resource_conflict');
    END IF;
    IF (a.display_name,a.owner_unit,a.deployment_units) IS NOT DISTINCT FROM (label,owner,units) THEN
      RETURN jsonb_build_object('status',200,'value',application_view(a));
    END IF;
    UPDATE applications v SET display_name=label, owner_unit=owner, deployment_units=units, revision=v.revision+1,
      digest='sha256:'||encode(sha256(convert_to('{"proposal":{"displayName":'||to_json(label)::text||
        ',"oauthClientId":'||to_json(a.oauth_client_id)::text||',"ownerSubject":'||to_json(a.owner_subject)::text||
        ',"providerOrigin":'||to_json(a.provider_origin)::text||'},"resourceId":'||to_json(a.app_id)::text||
        ',"tenantId":'||to_json(tenant)::text||'}','UTF8')),'hex')
      WHERE v.tenant_id=tenant AND v.app_id=a.app_id RETURNING * INTO a;
    PERFORM audit_append('application.updated','application',a.app_id,a.revision,'success',NULL,NULL);
    RETURN jsonb_build_object('status',200,'value',application_view(a));
  END IF;

  -- Provider writes are serialized with a per-application lease.
  IF operation='lease' THEN
    PERFORM 1 FROM app_sync_leases l WHERE l.tenant_id=tenant AND l.app_id=a.app_id AND l.expires_at>clock_timestamp()
      AND l.lease_id IS DISTINCT FROM (payload->>'lease')::uuid;
    IF FOUND THEN RETURN jsonb_build_object('status',409,'error','resource_conflict'); END IF;
    INSERT INTO app_sync_leases(tenant_id,app_id,lease_id,expires_at)
      VALUES(tenant,a.app_id,(payload->>'lease')::uuid,clock_timestamp()+interval '30 seconds')
      ON CONFLICT(tenant_id,app_id) DO UPDATE SET lease_id=EXCLUDED.lease_id,expires_at=EXCLUDED.expires_at;
    RETURN jsonb_build_object('status',200,'value',jsonb_build_object('oauthClientId',a.oauth_client_id,'providerReady',a.provider_ready));
  END IF;
  IF operation='release' THEN
    DELETE FROM app_sync_leases l WHERE l.tenant_id=tenant AND l.app_id=a.app_id AND l.lease_id=(payload->>'lease')::uuid;
    RETURN jsonb_build_object('status',200);
  END IF;
  IF NOT EXISTS (SELECT FROM app_sync_leases l WHERE l.tenant_id=tenant AND l.app_id=a.app_id
      AND l.lease_id=(payload->>'lease')::uuid AND l.expires_at>clock_timestamp()) THEN
    RETURN jsonb_build_object('status',409,'error','resource_conflict');
  END IF;

  IF operation='provider_confirm' THEN
    UPDATE applications v SET provider_ready=true WHERE v.tenant_id=tenant AND v.app_id=a.app_id;
    RETURN jsonb_build_object('status',200);
  END IF;

  IF operation='assignment_sync' AND worker THEN
    SELECT s.* INTO x FROM app_assignments s WHERE s.tenant_id=tenant AND s.app_id=a.app_id
      AND s.assignment_id=(payload->>'assignmentId')::uuid FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('status',200,'value',null::jsonb); END IF;
    IF x.enabled AND (a.state='revoked' OR NOT (x.unit=ANY(a.deployment_units))
        OR NOT EXISTS (SELECT FROM directory_units d WHERE (d.tenant_id,d.unit)=(tenant,x.unit) AND NOT d.pending_delete)
        OR x.target_type='group' AND NOT EXISTS (SELECT FROM directory_groups d
          WHERE (d.tenant_id,d.unit,d.unit_group)=(tenant,x.unit,x.target) AND NOT d.pending_delete)
        OR x.target_type='subject' AND NOT EXISTS (SELECT FROM directory_members d
          WHERE (d.tenant_id,d.unit,d.subject)=(tenant,x.unit,x.target) AND NOT d.pending_delete)) THEN
      UPDATE app_assignments s SET enabled=false,synchronized=false WHERE s.tenant_id=tenant AND s.app_id=a.app_id
        AND s.assignment_id=x.assignment_id RETURNING * INTO x;
    END IF;
    RETURN jsonb_build_object('status',200,'value',CASE WHEN NOT x.synchronized THEN assignment_view(x) END);
  END IF;
  IF operation='assignment_put' THEN
    IF a.state<>'active' THEN RETURN jsonb_build_object('status',409,'error','invalid_transition'); END IF;
    assignee := payload->>'target';
    IF NOT ((payload->>'unit')=ANY(a.deployment_units)) OR NOT EXISTS (
      SELECT FROM directory_units d WHERE d.tenant_id=tenant AND d.unit=payload->>'unit' AND NOT d.pending_delete AND d.confirmed_value IS NOT NULL FOR SHARE)
      OR (payload->>'targetType'='group' AND NOT EXISTS (
        SELECT FROM directory_groups d WHERE d.tenant_id=tenant AND d.unit=payload->>'unit'
          AND d.unit_group=assignee AND NOT d.pending_delete AND d.confirmed_value IS NOT NULL FOR SHARE))
      OR (payload->>'targetType'='subject' AND NOT EXISTS (
        SELECT FROM directory_members d WHERE d.tenant_id=tenant AND d.unit=payload->>'unit'
          AND d.subject=assignee AND NOT d.pending_delete AND d.confirmed_value IS NOT NULL FOR SHARE)) THEN
      RETURN jsonb_build_object('status',404,'error','not_found');
    END IF;
    INSERT INTO app_assignments AS s(tenant_id,app_id,unit,target_type,target,app_role)
      VALUES(tenant,a.app_id,payload->>'unit',payload->>'targetType',assignee,payload->>'role')
      ON CONFLICT(tenant_id,app_id,unit,target_type,target,app_role) DO UPDATE
        SET enabled=true,synchronized=s.enabled AND s.synchronized,
            assignment_id=CASE WHEN NOT s.enabled AND s.synchronized THEN gen_random_uuid() ELSE s.assignment_id END
      WHERE s.enabled OR s.synchronized
      RETURNING * INTO x;
    IF NOT FOUND THEN RETURN jsonb_build_object('status',409,'error','resource_conflict'); END IF;
  ELSIF operation IN ('assignment_delete','assignment_confirm') THEN
    UPDATE app_assignments s SET enabled=CASE WHEN operation='assignment_delete' THEN false ELSE s.enabled END,
      synchronized=CASE WHEN operation='assignment_delete' THEN NOT s.enabled AND s.synchronized ELSE true END
      WHERE s.tenant_id=tenant AND s.app_id=a.app_id AND s.assignment_id=(payload->>'assignmentId')::uuid
        AND (operation='assignment_delete' OR s.enabled=(payload->>'enabled')::boolean) RETURNING * INTO x;
    IF NOT FOUND THEN RETURN jsonb_build_object('status',CASE WHEN operation='assignment_confirm' THEN 409 ELSE 404 END,
      'error',CASE WHEN operation='assignment_confirm' THEN 'resource_conflict' ELSE 'not_found' END); END IF;
  ELSIF operation='rotation_start' THEN
    IF EXISTS (SELECT FROM app_oidc_rotations r WHERE r.tenant_id=tenant AND r.app_id=a.app_id
        AND r.rotation_id=(payload->>'rotationId')::uuid AND r.applied_at IS NOT NULL) THEN
      RETURN jsonb_build_object('status',200,'value',jsonb_build_object('applied',true));
    END IF;
    IF EXISTS (SELECT FROM app_oidc_rotations r WHERE r.tenant_id=tenant AND r.app_id=a.app_id AND r.applied_at IS NULL
        AND r.rotation_id<>(payload->>'rotationId')::uuid) THEN
      RETURN jsonb_build_object('status',409,'error','resource_conflict');
    END IF;
    INSERT INTO app_oidc_rotations(tenant_id,app_id,rotation_id)
      VALUES(tenant,a.app_id,(payload->>'rotationId')::uuid) ON CONFLICT DO NOTHING;
    SELECT r.* INTO rotation FROM app_oidc_rotations r WHERE r.tenant_id=tenant AND r.app_id=a.app_id
      AND r.rotation_id=(payload->>'rotationId')::uuid;
    RETURN jsonb_build_object('status',200,'value',jsonb_build_object('applied',rotation.applied_at IS NOT NULL));
  ELSIF operation='rotation_confirm' THEN
    UPDATE app_oidc_rotations r SET applied_at=clock_timestamp() WHERE r.tenant_id=tenant AND r.app_id=a.app_id
      AND r.rotation_id=(payload->>'rotationId')::uuid AND r.applied_at IS NULL;
    IF FOUND THEN
      PERFORM audit_append('application.oidc_key_rotated','application',a.app_id,a.revision,'success',NULL,payload->>'rotationId');
    END IF;
    RETURN jsonb_build_object('status',200);
  ELSE
    RETURN jsonb_build_object('status',400,'error','invalid_request');
  END IF;
  IF operation='assignment_confirm' THEN
    event_name := CASE WHEN x.enabled THEN 'application.assignment_granted' ELSE 'application.assignment_revoked' END;
    PERFORM audit_append(event_name,'application',a.app_id,a.revision,'success',NULL,x.assignment_id::text);
  END IF;
  RETURN jsonb_build_object('status',200,'value',assignment_view(x));
END $$;

CREATE FUNCTION core.record_app_denial(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private,pg_temp AS $$
DECLARE
  c jsonb := current_setting('request.jwt.claims',true)::jsonb;
  request_id uuid := (payload->>'requestId')::uuid; resource uuid; code text := payload->>'code';
BEGIN
  IF request_id IS NULL OR code IS NULL OR code NOT IN ('not_assigned_to_app','capability_not_granted',
      'consent_required','consent_revoked','consent_expired','unit_mismatch') THEN
    RETURN jsonb_build_object('status',400,'error','invalid_request');
  END IF;
  SELECT a.app_id INTO resource FROM applications a
    WHERE (a.tenant_id,a.issuer,a.oauth_client_id)=(c->>'tenant_id',c->>'iss',c->>'client_id');
  PERFORM audit_append('authorization.denied','authorization',coalesce(resource,request_id),0,
    'denied',code,request_id::text);
  RETURN jsonb_build_object('status',200);
END $$;

CREATE FUNCTION core.app_access_check(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private,pg_temp AS $$
DECLARE
  c jsonb := current_setting('request.jwt.claims',true)::jsonb;
  tenant text := c->>'tenant_id'; who text := c->>'sub'; iss text := c->>'iss'; client text := c->>'client_id';
  requested_unit text := c->>'app_unit'; selected_unit text; selected_roles text[];
  a applications; enrollment enrollments; backend boolean; code text; assigned jsonb;
BEGIN
  SELECT v.* INTO a FROM applications v WHERE (v.tenant_id,v.issuer,v.oauth_client_id)=(tenant,iss,client);
  IF NOT FOUND AND client<>'junctura-console' THEN
    IF NOT EXISTS (SELECT FROM enrollments e WHERE (e.tenant_id,e.issuer,e.oauth_client_id)=(tenant,iss,client)
        AND e.resource_subject IS DISTINCT FROM who) THEN RETURN jsonb_build_object('status',200,'value',null::jsonb); END IF;
  END IF;
  IF client='junctura-console' THEN
    IF c->>'console_role' IS NULL THEN code := 'not_assigned_to_app';
    ELSIF c->>'console_role'='viewer' AND coalesce((payload->>'write')::boolean,false) THEN code := 'capability_not_granted';
    ELSE RETURN jsonb_build_object('status',200,'value',null::jsonb);
    END IF;
  ELSE
    SELECT e.* INTO enrollment FROM enrollments e WHERE
      (e.tenant_id,e.issuer,e.oauth_client_id,e.owner_subject,e.provider_origin)=(tenant,iss,client,a.owner_subject,a.provider_origin);
    backend := coalesce(enrollment.resource_subject=who,false);
    -- Keep the existing backend-only authority and error contract for unpartitioned apps.
    IF backend AND cardinality(a.deployment_units)=0 THEN RETURN jsonb_build_object('status',200,'value',null::jsonb); END IF;
    IF NOT coalesce(enrollment.enabled,false) OR a.state<>'active' THEN
      code := 'not_assigned_to_app';
    ELSIF payload ? 'managementAppId' AND EXISTS (
      SELECT FROM principals p
      WHERE (p.tenant_id,p.issuer,p.subject,p.management_client)=(tenant,iss,who,client) AND p.enabled
        AND ('applications.approve'=ANY(p.permissions) OR
          'applications.register'=ANY(p.permissions) AND EXISTS (
            SELECT FROM applications v WHERE (v.tenant_id,v.issuer,v.owner_subject)=(tenant,iss,who)
              AND (payload->>'managementAppId' IS NULL OR v.app_id=(payload->>'managementAppId')::uuid)))
    ) THEN
      RETURN jsonb_build_object('status',200,'value',null::jsonb);
    ELSIF backend THEN
      IF requested_unit=ANY(a.deployment_units) AND EXISTS (
        SELECT FROM directory_units u WHERE u.tenant_id=tenant AND u.unit=requested_unit AND NOT u.pending_delete
          AND u.confirmed_value IS NOT NULL) THEN selected_unit := requested_unit;
      ELSE code := 'unit_mismatch'; END IF;
    ELSE
      SELECT coalesce(jsonb_object_agg(g.unit,g.roles),'{}'::jsonb) INTO assigned FROM (
        SELECT s.unit,array_agg(DISTINCT s.app_role ORDER BY s.app_role) AS roles
        FROM app_assignments s
        JOIN directory_units u ON (u.tenant_id,u.unit)=(s.tenant_id,s.unit)
        JOIN directory_members m ON (m.tenant_id,m.unit,m.subject)=(s.tenant_id,s.unit,who)
        WHERE s.tenant_id=tenant AND s.app_id=a.app_id AND s.enabled AND s.synchronized
          AND (c->'client_roles') ? ('junctura-assignment-'||s.assignment_id)
          AND s.unit=ANY(a.deployment_units) AND NOT u.pending_delete AND u.confirmed_value IS NOT NULL
          AND NOT m.pending_delete AND m.confirmed_value IS NOT NULL
          AND (s.target_type='unit' OR s.target_type='subject' AND s.target=who OR s.target_type='group'
            AND (m.confirmed_value->'groups') ? s.target AND EXISTS (
              SELECT FROM directory_memberships g WHERE (g.tenant_id,g.unit,g.subject,g.unit_group)=(tenant,s.unit,who,s.target)))
        GROUP BY s.unit
      ) g;
      IF assigned='{}'::jsonb THEN code := 'not_assigned_to_app';
      ELSIF requested_unit IS NOT NULL AND assigned ? requested_unit AND (c->'units') ? requested_unit THEN selected_unit := requested_unit;
      ELSIF requested_unit IS NULL AND (SELECT count(*) FROM jsonb_object_keys(assigned))=1 THEN
        SELECT k.unit_key INTO selected_unit FROM jsonb_object_keys(assigned) AS k(unit_key) WHERE (c->'units') ? k.unit_key;
      END IF;
      IF code IS NULL AND selected_unit IS NULL THEN code := 'unit_mismatch'; END IF;
      IF selected_unit IS NOT NULL THEN
        selected_roles := ARRAY(SELECT r.app_role FROM jsonb_array_elements_text(assigned->selected_unit) AS r(app_role));
        IF coalesce((payload->>'write')::boolean,false) AND NOT (selected_roles && ARRAY['editor','manager']) OR
            (coalesce((payload->>'managerOnly')::boolean,false) AND NOT ('manager'=ANY(selected_roles))) THEN code := 'capability_not_granted'; END IF;
      END IF;
    END IF;
  END IF;
  IF code IS NULL AND selected_unit IS NOT NULL AND NOT coalesce((payload->>'userRoute')::boolean,false) THEN
    code := 'capability_not_granted';
  END IF;
  IF code IS NULL AND selected_unit IS NOT NULL AND payload ? 'resourceId' THEN
    IF (payload ? 'resourceCollection' AND EXISTS (SELECT FROM core.app_records r
          WHERE (r.tenant_id,r.owner_app_id,r.collection,r.id)=(tenant,a.app_id,payload->>'resourceCollection',(payload->>'resourceId')::uuid)
            AND r.resource_unit IS DISTINCT FROM selected_unit))
       OR (NOT payload ? 'resourceCollection' AND EXISTS (SELECT FROM resource_objects r
          WHERE (r.tenant_id,r.owner_app_id,r.id)=(tenant,a.app_id,(payload->>'resourceId')::uuid)
            AND r.resource_unit IS DISTINCT FROM selected_unit)) THEN
      code := 'unit_mismatch';
    END IF;
  END IF;
  IF code IS NOT NULL THEN
    PERFORM core.record_app_denial(jsonb_build_object('requestId',payload->>'requestId','code',code));
    RETURN jsonb_build_object('status',403,'error',code);
  END IF;
  RETURN jsonb_build_object('status',200,'value',jsonb_build_object('appId',a.app_id,'unit',selected_unit,
    'roles',coalesce(selected_roles,'{}'::text[]),'human',NOT backend));
END $$;

ALTER FUNCTION core.directory_command(text,jsonb) SET SCHEMA app_private;
REVOKE ALL ON FUNCTION app_private.directory_command(text,jsonb) FROM junctura_directory_api,junctura_directory_worker;
CREATE FUNCTION core.directory_command(operation text,payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private,pg_temp AS $$
DECLARE
  c jsonb := current_setting('request.jwt.claims',true)::jsonb;
  tenant text := c->>'tenant_id'; unit_key text := payload->>'unit'; items jsonb; total bigint;
BEGIN
  IF c->>'client_id'='junctura-console' AND c->>'console_role' IN ('admin','manager','viewer')
      AND operation IN ('unit_list','member_list','group_list') THEN
    IF operation<>'unit_list' AND NOT EXISTS (SELECT FROM directory_units u
        WHERE u.tenant_id=tenant AND u.unit=unit_key AND u.confirmed_value IS NOT NULL AND NOT u.pending_delete) THEN
      RETURN jsonb_build_object('status',404,'error','not_found');
    END IF;
    WITH matched AS (
      SELECT u.unit AS key,u.confirmed_value FROM directory_units u WHERE operation='unit_list'
        AND u.tenant_id=tenant AND NOT u.pending_delete
      UNION ALL
      SELECT m.subject,m.confirmed_value FROM directory_members m WHERE operation='member_list'
        AND (m.tenant_id,m.unit)=(tenant,unit_key) AND NOT m.pending_delete
      UNION ALL
      SELECT g.unit_group,g.confirmed_value FROM directory_groups g WHERE operation='group_list'
        AND (g.tenant_id,g.unit)=(tenant,unit_key) AND NOT g.pending_delete
    ), rows AS (
      SELECT key,confirmed_value,count(*) OVER () AS n FROM matched
        WHERE confirmed_value IS NOT NULL AND key>coalesce(payload->>'after','')
      ORDER BY key LIMIT least(greatest((payload->>'limit')::integer,1),100)
    )
    SELECT coalesce(jsonb_agg(confirmed_value ORDER BY key),'[]'::jsonb),coalesce(max(n),0)
      INTO items,total FROM rows;
    RETURN jsonb_build_object('status',200,'value',jsonb_build_object('items',items,'total',total));
  END IF;
  RETURN app_private.directory_command(operation,payload);
END $$;
REVOKE ALL ON FUNCTION core.directory_command(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.directory_command(text,jsonb) TO junctura_directory_api,junctura_directory_worker;

REVOKE ALL ON FUNCTION app_private.assignment_view(app_private.app_assignments),
  core.app_access_check(jsonb),core.record_app_denial(jsonb),core.application_management(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.app_access_check(jsonb),core.record_app_denial(jsonb) TO junctura_app_access_api;
GRANT EXECUTE ON FUNCTION core.application_management(text,jsonb) TO junctura_app_api;
RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (47);
NOTIFY pgrst,'reload schema';
COMMIT;
