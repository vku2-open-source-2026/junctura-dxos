-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
-- Read-only application counts and activity timestamps for audit.read principals.
-- The owner SELECT paths remain subject to FORCE RLS: tenant_isolation on the
-- private tables (003/006/007/010), tenant_operator on app_records (004), and
-- the app_records SELECT grant in 025/026. No additional table access is needed.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='junctura_application_stats_api') THEN
    CREATE ROLE junctura_application_stats_api NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT junctura_application_stats_api TO junctura_data;
GRANT USAGE ON SCHEMA core TO junctura_application_stats_api;

GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

CREATE OR REPLACE FUNCTION core.application_stats(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $$
DECLARE c jsonb; tenant text; who text; iss text; client text;
  stats jsonb;
BEGIN
  IF payload IS NULL OR jsonb_typeof(payload)<>'object' OR payload<>'{}'::jsonb THEN
    RETURN jsonb_build_object('status',400,'error','invalid_query');
  END IF;
  BEGIN c:=current_setting('request.jwt.claims',true)::jsonb;
  EXCEPTION WHEN others THEN c:=NULL; END;
  IF c IS NULL OR jsonb_typeof(c)<>'object' THEN
    RETURN jsonb_build_object('status',403,'error','stats_permission_required');
  END IF;
  tenant:=c->>'tenant_id'; who:=c->>'sub'; iss:=c->>'iss'; client:=c->>'client_id';
  IF tenant IS NULL OR tenant !~ '^[a-z][a-z0-9-]{0,62}$' OR coalesce(who,'')='' OR
     coalesce(iss,'')='' OR coalesce(client,'')='' THEN
    RETURN jsonb_build_object('status',403,'error','stats_permission_required');
  END IF;
  PERFORM 1 FROM app_private.principals p
    WHERE p.tenant_id=tenant AND p.issuer=iss AND p.subject=who
      AND p.management_client=client AND p.enabled
      AND p.permissions @> ARRAY['audit.read']::text[];
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status',403,'error','stats_permission_required');
  END IF;

  WITH app_rows AS (
    SELECT a.app_id, a.display_name, a.state, a.created_at
      FROM app_private.applications a
      WHERE a.tenant_id=tenant AND a.issuer=iss
  ), audit_times AS (
    SELECT au.actor_app_id, max(au.occurred_at) AS last_activity_at
      FROM app_private.audit au
      WHERE au.tenant_id=tenant AND au.issuer=iss
      GROUP BY au.actor_app_id
  ), outgoing AS (
    SELECT e.consumer_app_id AS app_id, max(e.created_at) AS last_activity_at,
        count(*) FILTER (WHERE e.created_at>=now()-interval '24 hours') AS last24h,
        count(*) FILTER (WHERE e.created_at>=now()-interval '7 days') AS last7d
      FROM execution_private.executions e
      WHERE e.tenant_id=tenant AND e.issuer=iss
      GROUP BY e.consumer_app_id
  ), incoming AS (
    SELECT e.provider_app_id AS app_id, max(e.created_at) AS last_activity_at,
        count(*) FILTER (WHERE e.created_at>=now()-interval '24 hours') AS last24h,
        count(*) FILTER (WHERE e.created_at>=now()-interval '7 days') AS last7d
      FROM execution_private.executions e
      WHERE e.tenant_id=tenant AND e.issuer=iss
      GROUP BY e.provider_app_id
  ), published AS (
    SELECT cv.provider_app_id, count(*) AS versions
      FROM app_private.capability_versions cv
      JOIN app_rows a ON a.app_id=cv.provider_app_id
      WHERE cv.tenant_id=tenant AND cv.state='published'
      GROUP BY cv.provider_app_id
  ), active_grants AS (
    SELECT g.provider_app_id, g.consumer_app_id
      FROM trust_private.grants g
      WHERE g.tenant_id=tenant AND g.issuer=iss AND g.state='active' AND g.expires_at>now()
  ), record_counts AS (
    SELECT r.owner_app_id, count(DISTINCT r.collection) AS collections, count(*) AS records
      FROM core.app_records r
      JOIN app_rows a ON a.app_id=r.owner_app_id
      WHERE r.tenant_id=tenant
      GROUP BY r.owner_app_id
  ), app_stats AS (
    SELECT a.app_id, a.display_name, a.state, a.created_at,
        greatest(au.last_activity_at,o.last_activity_at,i.last_activity_at) AS last_activity_at,
        coalesce(o.last24h,0) AS outgoing24h, coalesce(o.last7d,0) AS outgoing7d,
        coalesce(i.last24h,0) AS incoming24h, coalesce(i.last7d,0) AS incoming7d,
        coalesce(p.versions,0) AS published,
        (SELECT count(*) FROM active_grants g WHERE g.provider_app_id=a.app_id) AS given,
        (SELECT count(*) FROM active_grants g WHERE g.consumer_app_id=a.app_id) AS received,
        coalesce(r.collections,0) AS collections, coalesce(r.records,0) AS records
      FROM app_rows a
      LEFT JOIN audit_times au ON au.actor_app_id=a.app_id
      LEFT JOIN outgoing o ON o.app_id=a.app_id
      LEFT JOIN incoming i ON i.app_id=a.app_id
      LEFT JOIN published p ON p.provider_app_id=a.app_id
      LEFT JOIN record_counts r ON r.owner_app_id=a.app_id
  )
  SELECT jsonb_build_object(
      'totals',jsonb_build_object(
        'applications',count(*),
        'activeApplications',count(*) FILTER (WHERE a.state='active'),
        'activeLast24h',count(*) FILTER (WHERE a.last_activity_at>=now()-interval '24 hours'),
        'activeLast7d',count(*) FILTER (WHERE a.last_activity_at>=now()-interval '7 days'),
        'activeConnections',(SELECT count(*) FROM active_grants)),
      'applications',coalesce(jsonb_agg(jsonb_build_object(
        'id',a.app_id,'name',a.display_name,'state',a.state,
        'registeredAt',a.created_at,'lastActivityAt',a.last_activity_at,
        'calls',jsonb_build_object(
          'outgoing',jsonb_build_object('last24h',a.outgoing24h,'last7d',a.outgoing7d),
          'incoming',jsonb_build_object('last24h',a.incoming24h,'last7d',a.incoming7d)),
        'capabilities',jsonb_build_object('published',a.published),
        'connections',jsonb_build_object('given',a.given,'received',a.received),
        'data',jsonb_build_object('collections',a.collections,'records',a.records))
        ORDER BY a.display_name,a.app_id),'[]'::jsonb))
    INTO stats FROM app_stats a;

  RETURN jsonb_build_object('status',200,'value',stats);
END $$;

RESET ROLE;
ALTER FUNCTION core.application_stats(jsonb) OWNER TO junctura_app_owner;
REVOKE ALL ON FUNCTION core.application_stats(jsonb) FROM PUBLIC,junctura_api,junctura_app_api,junctura_resource_api,junctura_audit_api,junctura_capability_api,junctura_trust_api,junctura_execution_api,junctura_composition_api,junctura_subject_api,junctura_directory_api,junctura_storage_api,junctura_storage_collections_api,junctura_workflow_audit_api;
GRANT EXECUTE ON FUNCTION core.application_stats(jsonb) TO junctura_application_stats_api;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES(27);
NOTIFY pgrst,'reload schema';
COMMIT;
