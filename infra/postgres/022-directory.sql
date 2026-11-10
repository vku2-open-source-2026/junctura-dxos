-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
-- Read-only tenant directory: enrolled management principals and the real
-- tenant/application tree with the current trust relations. Both functions are
-- gated by audit.read on the verified caller and are executable only by the
-- private directory role. Nothing here reads Keycloak, exposes secrets or
-- changes state.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='junctura_directory_api') THEN
    CREATE ROLE junctura_directory_api NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT junctura_directory_api TO junctura_data;
GRANT USAGE ON SCHEMA core TO junctura_directory_api;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

CREATE OR REPLACE FUNCTION core.directory_principals(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c jsonb; tenant text; who text; iss text; client text;
  items jsonb; total integer; max_items constant integer := 1000;
BEGIN
  IF payload IS NULL OR jsonb_typeof(payload)<>'object' OR payload<>'{}'::jsonb THEN
    RETURN jsonb_build_object('status',400,'error','invalid_directory_request');
  END IF;
  BEGIN c:=current_setting('request.jwt.claims',true)::jsonb;
  EXCEPTION WHEN others THEN c:=NULL; END;
  IF c IS NULL OR jsonb_typeof(c)<>'object' THEN
    RETURN jsonb_build_object('status',403,'error','directory_permission_required');
  END IF;
  tenant:=c->>'tenant_id'; who:=c->>'sub'; iss:=c->>'iss'; client:=c->>'client_id';
  IF tenant IS NULL OR tenant !~ '^[a-z][a-z0-9-]{0,62}$' OR coalesce(who,'')='' OR
     coalesce(iss,'')='' OR coalesce(client,'')='' THEN
    RETURN jsonb_build_object('status',403,'error','directory_permission_required');
  END IF;
  PERFORM 1 FROM app_private.principals p
    WHERE p.tenant_id=tenant AND p.issuer=iss AND p.subject=who
      AND p.management_client=client AND p.enabled
      AND p.permissions @> ARRAY['audit.read']::text[];
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status',403,'error','directory_permission_required');
  END IF;

  WITH visible AS (
    SELECT p.subject, p.issuer, p.management_client, p.permissions, p.enabled
      FROM app_private.principals p
      WHERE p.tenant_id=tenant AND p.issuer=iss
  ), limited AS (
    SELECT * FROM visible ORDER BY subject, issuer, management_client LIMIT max_items
  )
  SELECT (SELECT count(*) FROM visible), coalesce(jsonb_agg(jsonb_build_object(
      'subject',l.subject,'issuer',l.issuer,'managementClient',l.management_client,
      'permissions',to_jsonb(l.permissions),'enabled',l.enabled)
      ORDER BY l.subject,l.issuer,l.management_client),'[]'::jsonb)
    INTO total, items FROM limited l;
  RETURN jsonb_build_object('status',200,'value',jsonb_build_object(
    'items',items,'truncated',total>max_items));
END $$;

CREATE OR REPLACE FUNCTION core.directory_organizations(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c jsonb; tenant text; who text; iss text; client text;
  apps jsonb; relations jsonb; app_total integer; relation_total integer;
  max_apps constant integer := 1000; max_relations constant integer := 500;
BEGIN
  IF payload IS NULL OR jsonb_typeof(payload)<>'object' OR payload<>'{}'::jsonb THEN
    RETURN jsonb_build_object('status',400,'error','invalid_directory_request');
  END IF;
  BEGIN c:=current_setting('request.jwt.claims',true)::jsonb;
  EXCEPTION WHEN others THEN c:=NULL; END;
  IF c IS NULL OR jsonb_typeof(c)<>'object' THEN
    RETURN jsonb_build_object('status',403,'error','directory_permission_required');
  END IF;
  tenant:=c->>'tenant_id'; who:=c->>'sub'; iss:=c->>'iss'; client:=c->>'client_id';
  IF tenant IS NULL OR tenant !~ '^[a-z][a-z0-9-]{0,62}$' OR coalesce(who,'')='' OR
     coalesce(iss,'')='' OR coalesce(client,'')='' THEN
    RETURN jsonb_build_object('status',403,'error','directory_permission_required');
  END IF;
  PERFORM 1 FROM app_private.principals p
    WHERE p.tenant_id=tenant AND p.issuer=iss AND p.subject=who
      AND p.management_client=client AND p.enabled
      AND p.permissions @> ARRAY['audit.read']::text[];
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status',403,'error','directory_permission_required');
  END IF;

  WITH visible AS (
    SELECT a.app_id, a.display_name FROM app_private.applications a
      WHERE a.tenant_id=tenant AND a.issuer=iss
  ), limited AS (
    SELECT * FROM visible ORDER BY display_name, app_id LIMIT max_apps
  )
  SELECT (SELECT count(*) FROM visible), coalesce(jsonb_agg(jsonb_build_object(
      'id',l.app_id,'name',l.display_name,'kind','application','children','[]'::jsonb)
      ORDER BY l.display_name,l.app_id),'[]'::jsonb)
    INTO app_total, apps FROM limited l;

  WITH visible AS (
    SELECT g.* FROM trust_private.grants g
      WHERE g.tenant_id=tenant AND g.issuer=iss
        AND g.state<>'revoked' AND g.expires_at>statement_timestamp()
  ), limited AS (
    SELECT * FROM visible ORDER BY created_at DESC, grant_id LIMIT max_relations
  )
  SELECT (SELECT count(*) FROM visible), coalesce(jsonb_agg(jsonb_build_object(
      'from',l.provider_app_id,'to',l.consumer_app_id,
      'label',coalesce(NULLIF((SELECT v.manifest->>'title' FROM app_private.capability_versions v
        WHERE v.tenant_id=l.tenant_id AND v.version_id=l.version_id),''),l.capability_id))
      ORDER BY l.created_at DESC,l.grant_id),'[]'::jsonb)
    INTO relation_total, relations FROM limited l;

  RETURN jsonb_build_object('status',200,'value',jsonb_build_object(
    'root',jsonb_build_object('id',tenant,'name',tenant,'kind','platform','children',apps),
    'relations',relations,
    'truncated',app_total>max_apps OR relation_total>max_relations));
END $$;

RESET ROLE;
ALTER FUNCTION core.directory_principals(jsonb) OWNER TO junctura_app_owner;
ALTER FUNCTION core.directory_organizations(jsonb) OWNER TO junctura_app_owner;
REVOKE ALL ON FUNCTION core.directory_principals(jsonb) FROM PUBLIC,junctura_api,junctura_app_api,junctura_resource_api,junctura_audit_api,junctura_capability_api,junctura_trust_api,junctura_execution_api,junctura_composition_api,junctura_subject_api;
REVOKE ALL ON FUNCTION core.directory_organizations(jsonb) FROM PUBLIC,junctura_api,junctura_app_api,junctura_resource_api,junctura_audit_api,junctura_capability_api,junctura_trust_api,junctura_execution_api,junctura_composition_api,junctura_subject_api;
GRANT EXECUTE ON FUNCTION core.directory_principals(jsonb) TO junctura_directory_api;
GRANT EXECUTE ON FUNCTION core.directory_organizations(jsonb) TO junctura_directory_api;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES(22);
NOTIFY pgrst,'reload schema';
COMMIT;
