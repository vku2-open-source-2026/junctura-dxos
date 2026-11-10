-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
-- Read-only aggregate views for management principals. They expose counts and
-- timestamps only: never record content, object keys, object names or bytes.
-- Both functions are gated by audit.read on the verified caller and are
-- executable only by their private roles.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='junctura_storage_api') THEN
    CREATE ROLE junctura_storage_api NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='junctura_workflow_audit_api') THEN
    CREATE ROLE junctura_workflow_audit_api NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT junctura_storage_api TO junctura_data;
GRANT junctura_workflow_audit_api TO junctura_data;
GRANT USAGE ON SCHEMA core TO junctura_storage_api;
GRANT USAGE ON SCHEMA core TO junctura_workflow_audit_api;

-- The aggregate function runs as the application owner, so that role needs a
-- tenant-scoped read path over both record tables. RLS still applies.
GRANT SELECT ON core.records TO junctura_app_owner;
GRANT SELECT ON core.app_records TO junctura_app_owner;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE schemaname='core' AND tablename='records' AND policyname='operator_read') THEN
    CREATE POLICY operator_read ON core.records FOR SELECT TO junctura_app_owner
      USING (tenant_id = (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id'));
  END IF;
END $$;

GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

CREATE OR REPLACE FUNCTION core.storage_summary(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $$
DECLARE c jsonb; tenant text; who text; iss text; client text;
  apps jsonb; total_collections jsonb;
BEGIN
  IF payload IS NULL OR jsonb_typeof(payload)<>'object' OR payload<>'{}'::jsonb THEN
    RETURN jsonb_build_object('status',400,'error','invalid_storage_request');
  END IF;
  BEGIN c:=current_setting('request.jwt.claims',true)::jsonb;
  EXCEPTION WHEN others THEN c:=NULL; END;
  IF c IS NULL OR jsonb_typeof(c)<>'object' THEN
    RETURN jsonb_build_object('status',403,'error','storage_permission_required');
  END IF;
  tenant:=c->>'tenant_id'; who:=c->>'sub'; iss:=c->>'iss'; client:=c->>'client_id';
  IF tenant IS NULL OR tenant !~ '^[a-z][a-z0-9-]{0,62}$' OR coalesce(who,'')='' OR
     coalesce(iss,'')='' OR coalesce(client,'')='' THEN
    RETURN jsonb_build_object('status',403,'error','storage_permission_required');
  END IF;
  PERFORM 1 FROM app_private.principals p
    WHERE p.tenant_id=tenant AND p.issuer=iss AND p.subject=who
      AND p.management_client=client AND p.enabled
      AND p.permissions @> ARRAY['audit.read']::text[];
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status',403,'error','storage_permission_required');
  END IF;

  WITH app_rows AS (
    SELECT a.app_id, a.display_name, a.state
      FROM app_private.applications a
      WHERE a.tenant_id=tenant AND a.issuer=iss
  ), record_counts AS (
    SELECT r.owner_app_id, r.collection, count(*)::int AS records, max(r.created_at) AS updated_at
      FROM core.app_records r
      WHERE r.tenant_id=tenant
      GROUP BY r.owner_app_id, r.collection
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id',a.app_id,'name',a.display_name,'state',a.state,
      'collections',coalesce((SELECT jsonb_agg(jsonb_build_object(
          'name',rc.collection,'records',rc.records,'updatedAt',rc.updated_at)
          ORDER BY rc.collection)
        FROM record_counts rc WHERE rc.owner_app_id=a.app_id),'[]'::jsonb))
      ORDER BY a.display_name,a.app_id),'[]'::jsonb)
    INTO apps FROM app_rows a;

  WITH all_counts AS (
    SELECT collection, count(*)::int AS records, max(created_at) AS updated_at
      FROM core.app_records WHERE tenant_id=tenant GROUP BY collection
    UNION ALL
    SELECT collection, count(*)::int AS records, max(created_at) AS updated_at
      FROM core.records WHERE tenant_id=tenant GROUP BY collection
  ), combined AS (
    SELECT collection, sum(records)::int AS records, max(updated_at) AS updated_at
      FROM all_counts GROUP BY collection
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'name',collection,'records',records,'updatedAt',updated_at)
      ORDER BY collection),'[]'::jsonb)
    INTO total_collections FROM combined;

  RETURN jsonb_build_object('status',200,'value',jsonb_build_object(
    'applications',apps,
    'totals',jsonb_build_object('collections',total_collections)));
END $$;

CREATE OR REPLACE FUNCTION core.workflow_audit_access(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $$
DECLARE c jsonb; tenant text; who text; iss text; client text;
BEGIN
  IF payload IS NULL OR jsonb_typeof(payload)<>'object' OR payload<>'{}'::jsonb THEN
    RETURN jsonb_build_object('status',400,'error','invalid_workflow_audit_request');
  END IF;
  BEGIN c:=current_setting('request.jwt.claims',true)::jsonb;
  EXCEPTION WHEN others THEN c:=NULL; END;
  IF c IS NULL OR jsonb_typeof(c)<>'object' THEN
    RETURN jsonb_build_object('status',403,'error','workflow_audit_permission_required');
  END IF;
  tenant:=c->>'tenant_id'; who:=c->>'sub'; iss:=c->>'iss'; client:=c->>'client_id';
  IF tenant IS NULL OR tenant !~ '^[a-z][a-z0-9-]{0,62}$' OR coalesce(who,'')='' OR
     coalesce(iss,'')='' OR coalesce(client,'')='' THEN
    RETURN jsonb_build_object('status',403,'error','workflow_audit_permission_required');
  END IF;
  PERFORM 1 FROM app_private.principals p
    WHERE p.tenant_id=tenant AND p.issuer=iss AND p.subject=who
      AND p.management_client=client AND p.enabled
      AND p.permissions @> ARRAY['audit.read']::text[];
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status',403,'error','workflow_audit_permission_required');
  END IF;
  RETURN jsonb_build_object('status',200,'value',jsonb_build_object('allowed',true));
END $$;

RESET ROLE;
ALTER FUNCTION core.storage_summary(jsonb) OWNER TO junctura_app_owner;
ALTER FUNCTION core.workflow_audit_access(jsonb) OWNER TO junctura_app_owner;
REVOKE ALL ON FUNCTION core.storage_summary(jsonb) FROM PUBLIC,junctura_api,junctura_app_api,junctura_resource_api,junctura_audit_api,junctura_capability_api,junctura_trust_api,junctura_execution_api,junctura_composition_api,junctura_subject_api,junctura_directory_api,junctura_workflow_audit_api;
REVOKE ALL ON FUNCTION core.workflow_audit_access(jsonb) FROM PUBLIC,junctura_api,junctura_app_api,junctura_resource_api,junctura_audit_api,junctura_capability_api,junctura_trust_api,junctura_execution_api,junctura_composition_api,junctura_subject_api,junctura_directory_api,junctura_storage_api;
GRANT EXECUTE ON FUNCTION core.storage_summary(jsonb) TO junctura_storage_api;
GRANT EXECUTE ON FUNCTION core.workflow_audit_access(jsonb) TO junctura_workflow_audit_api;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES(25);
NOTIFY pgrst,'reload schema';
COMMIT;
