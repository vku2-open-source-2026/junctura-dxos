-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;
DO $fix$
DECLARE source text; original text;
BEGIN
  source := pg_get_functiondef('core.app_access_check(jsonb)'::regprocedure);
  original := source;
  source := replace(source,
    $old$  IF NOT FOUND AND client<>'junctura-console' THEN
    IF NOT EXISTS (SELECT FROM enrollments e WHERE (e.tenant_id,e.issuer,e.oauth_client_id)=(tenant,iss,client)
        AND e.resource_subject IS DISTINCT FROM who) THEN RETURN jsonb_build_object('status',200,'value',null::jsonb); END IF;
  END IF;
$old$,
    $body$  -- Legacy clients keep route-specific authority. Past grants keep revoked logins fenced after undeployment.
  IF client<>'junctura-console' AND (NOT FOUND OR cardinality(a.deployment_units)=0 AND NOT EXISTS (
    SELECT FROM app_assignments s WHERE (s.tenant_id,s.app_id)=(tenant,a.app_id)
  )) THEN
    RETURN jsonb_build_object('status',200,'value',null::jsonb);
  END IF;
$body$);
  IF source=original THEN RAISE EXCEPTION 'Unexpected app access check'; END IF;
  EXECUTE source;

  source := pg_get_functiondef('core.application_management(text,jsonb)'::regprocedure);
  original := source;
  source := replace(source, 'NOT v.provider_ready AND v.state<>''revoked''',
    'NOT v.provider_ready AND v.state=''active'' AND cardinality(v.deployment_units)>0');
  IF source=original THEN RAISE EXCEPTION 'Unexpected app sync query'; END IF;
  original := source;
  source := replace(source, '  SELECT v.* INTO a FROM applications v WHERE v.tenant_id=tenant AND v.issuer=iss',
    $body$  IF operation='get' AND perms IS NULL AND NOT browse THEN
    RETURN jsonb_build_object('status',403,'error','application_permission_required');
  END IF;
  SELECT v.* INTO a FROM applications v WHERE v.tenant_id=tenant AND v.issuer=iss$body$);
  IF source=original THEN RAISE EXCEPTION 'Unexpected app management lookup'; END IF;
  EXECUTE source;

  source := pg_get_functiondef('app_private.application_management_command(text,jsonb)'::regprocedure);
  original := source;
  source := replace(source, 'operation IN (''approve'',''state'')', 'operation IN (''approve'',''approve_check'',''state'')');
  source := replace(source, 'operation=''approve''', 'operation IN (''approve'',''approve_check'')');
  IF source=original THEN RAISE EXCEPTION 'Unexpected approval transition'; END IF;
  original := source;
  source := replace(source, '        UPDATE app_private.approvals SET state=''consumed'',revision=revision+1',
    $body$        IF operation='approve_check' THEN RETURN jsonb_build_object('status',200); END IF;
        UPDATE app_private.approvals SET state='consumed',revision=revision+1$body$);
  IF source=original THEN RAISE EXCEPTION 'Unexpected approval consumption'; END IF;
  EXECUTE source;
END $fix$;
RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES(50);
NOTIFY pgrst,'reload schema';
COMMIT;
