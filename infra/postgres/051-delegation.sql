-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

DO $migration$
DECLARE source text; updated text;
BEGIN
  source := pg_get_functiondef('core.record_app_denial(jsonb)'::regprocedure);
  updated := replace(source, $old$'consent_expired','unit_mismatch'$old$,
    $new$'consent_expired','unit_mismatch','delegation_not_allowed'$new$);
  IF updated=source THEN RAISE EXCEPTION 'Unexpected denial codes'; END IF;
  EXECUTE updated;

  source := pg_get_functiondef('app_private.audit_guard()'::regprocedure);
  updated := replace(source, $old$  ELSE
    actor:=core.resource_actor();$old$, $new$  ELSIF c->>'role'='junctura_app_access_api' AND c ? 'actor_sub' AND
      NEW.event IN ('authorization.denied','delegation.exchanged','delegation.authorized') THEN
    SELECT a.app_id INTO actor FROM applications a JOIN enrollments e
      USING (tenant_id,issuer,oauth_client_id,owner_subject,provider_origin)
    WHERE (a.tenant_id,a.issuer,a.oauth_client_id,e.resource_subject)=(tenant,iss,client,c->>'actor_sub');
  ELSE
    actor:=core.resource_actor();$new$);
  IF updated=source THEN RAISE EXCEPTION 'Unexpected audit actor resolution'; END IF;
  EXECUTE updated;
END $migration$;

CREATE FUNCTION core.delegation_access_check(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private,pg_temp AS $$
DECLARE
  c jsonb := current_setting('request.jwt.claims',true)::jsonb;
  actor uuid; access jsonb; code text; selected_unit text; event_name text;
  request_id uuid := (payload->>'requestId')::uuid;
BEGIN
  IF request_id IS NULL THEN RETURN jsonb_build_object('status',400,'error','invalid_request'); END IF;
  SELECT a.app_id INTO actor FROM applications a JOIN enrollments e
    USING (tenant_id,issuer,oauth_client_id,owner_subject,provider_origin)
  WHERE (a.tenant_id,a.issuer,a.oauth_client_id,e.resource_subject)=(c->>'tenant_id',c->>'iss',c->>'client_id',c->>'actor_sub')
    AND e.enabled AND a.state='active' AND cardinality(a.deployment_units)>0;
  IF actor IS NULL OR c->>'sub'=c->>'actor_sub' THEN
    code := 'delegation_not_allowed';
  ELSE
    access := core.app_access_check(payload-'managementAppId');
    IF access->>'status' IS DISTINCT FROM '200' THEN RETURN access; END IF;
    selected_unit := access->'value'->>'unit';
    IF access->'value'->>'human' IS DISTINCT FROM 'true' OR selected_unit IS NULL
        OR access->'value'->>'appId' IS DISTINCT FROM actor::text THEN
      code := 'not_assigned_to_app';
    ELSIF payload ? 'sourceClient' AND payload->>'sourceClient' IS DISTINCT FROM c->>'client_id' THEN
      code := 'delegation_not_allowed';
    ELSIF c ? 'actor_unit' AND c->>'actor_unit' IS DISTINCT FROM selected_unit THEN
      code := 'unit_mismatch';
    ELSIF payload->>'write'='true' AND c->>'delegated_writer' IS DISTINCT FROM 'true' THEN
      code := 'capability_not_granted';
    END IF;
  END IF;
  IF code IS NOT NULL THEN
    PERFORM core.record_app_denial(jsonb_build_object('requestId',request_id,'code',code));
    RETURN jsonb_build_object('status',403,'error',code);
  END IF;
  event_name := CASE payload->>'delegationEvent' WHEN 'exchanged' THEN 'delegation.exchanged'
    WHEN 'authorized' THEN 'delegation.authorized' END;
  IF event_name IS NOT NULL THEN
    PERFORM audit_append(event_name,'delegation',actor,0,'success',NULL,request_id::text);
  END IF;
  RETURN access;
END $$;

REVOKE ALL ON FUNCTION core.delegation_access_check(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.delegation_access_check(jsonb) TO junctura_app_access_api;
RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES(51);
NOTIFY pgrst,'reload schema';
COMMIT;
