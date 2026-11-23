-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
ALTER TABLE core.app_records ADD COLUMN resource_unit text
  DEFAULT (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'resource_unit');
ALTER TABLE app_private.resource_objects ADD COLUMN resource_unit text
  DEFAULT (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'resource_unit');

-- Restrict every existing read/write policy, including SECURITY DEFINER RPCs.
-- Workers have a read exception for maintenance under their existing policies.
CREATE POLICY record_unit_isolation ON core.app_records AS RESTRICTIVE
  USING (resource_unit IS NOT DISTINCT FROM (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'resource_unit')
    OR current_setting('request.jwt.claims',true)::jsonb->>'role' IN ('junctura_search_worker','junctura_app_access_api'))
  WITH CHECK (resource_unit IS NOT DISTINCT FROM (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'resource_unit'));
CREATE POLICY object_unit_isolation ON app_private.resource_objects AS RESTRICTIVE
  USING (resource_unit IS NOT DISTINCT FROM (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'resource_unit')
    OR current_setting('request.jwt.claims',true)::jsonb->>'role' IN ('junctura_search_worker','junctura_objects_worker','junctura_app_access_api'))
  WITH CHECK (resource_unit IS NOT DISTINCT FROM (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'resource_unit')
    OR current_setting('request.jwt.claims',true)::jsonb->>'role'='junctura_objects_worker');

DROP INDEX core.app_records_unique_key_idx;
CREATE UNIQUE INDEX app_records_unique_key_idx ON core.app_records
  (tenant_id,owner_app_id,collection,resource_unit,unique_key_value) NULLS NOT DISTINCT
  WHERE unique_key_value IS NOT NULL;

GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;
CREATE OR REPLACE FUNCTION core.resource_actor() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $$
  SELECT a.app_id FROM app_private.applications a JOIN app_private.enrollments e
    ON (e.tenant_id,e.issuer,e.oauth_client_id,e.owner_subject,e.provider_origin)=
       (a.tenant_id,a.issuer,a.oauth_client_id,a.owner_subject,a.provider_origin)
  CROSS JOIN (SELECT current_setting('request.jwt.claims',true)::jsonb AS c) claims
  WHERE a.tenant_id=claims.c->>'tenant_id' AND a.issuer=claims.c->>'iss' AND a.oauth_client_id=claims.c->>'client_id'
    AND (e.resource_subject=claims.c->>'sub' OR a.app_id::text=claims.c->>'human_app_id')
    AND (coalesce(claims.c->>'resource_unit'=ANY(a.deployment_units),false)
         OR cardinality(a.deployment_units)=0 AND claims.c->>'resource_unit' IS NULL)
    AND a.state='active' AND e.enabled
$$;

CREATE OR REPLACE FUNCTION app_private.record_actor(p_lock boolean) RETURNS uuid
LANGUAGE plpgsql SET search_path=pg_catalog,app_private AS $$
DECLARE actor uuid := core.resource_actor();
BEGIN
  IF p_lock AND actor IS NOT NULL THEN
    PERFORM 1 FROM applications a JOIN enrollments e USING (tenant_id,issuer,oauth_client_id,owner_subject,provider_origin)
      WHERE a.tenant_id=record_tenant() AND a.app_id=actor FOR SHARE OF a,e;
    RETURN core.resource_actor();
  END IF;
  RETURN actor;
END $$;

CREATE OR REPLACE FUNCTION app_private.record_caller_scope(p_actor uuid) RETURNS bytea
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT sha256(convert_to((jsonb_build_array(claims.c->>'iss',claims.c->>'sub',claims.c->>'client_id',p_actor,claims.c->>'delegated_sub') ||
    CASE WHEN claims.c ? 'resource_unit' THEN jsonb_build_array(claims.c->>'resource_unit') ELSE '[]'::jsonb END)::text,'UTF8'))
  FROM (SELECT current_setting('request.jwt.claims',true)::jsonb AS c) claims
$$;
RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (48);
NOTIFY pgrst,'reload schema';
COMMIT;
