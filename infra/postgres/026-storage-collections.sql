-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
-- Read-only collection structure for management principals. The function infers
-- field names and JSON types from at most the 200 newest records of each
-- collection and never returns a record value. A dedicated private role makes
-- the audit.read gate explicit at the database boundary.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='junctura_storage_collections_api') THEN
    CREATE ROLE junctura_storage_collections_api NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT junctura_storage_collections_api TO junctura_data;
GRANT USAGE ON SCHEMA core TO junctura_storage_collections_api;
GRANT SELECT ON core.app_records TO junctura_app_owner;

GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

CREATE OR REPLACE FUNCTION core.storage_collections(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $$
DECLARE c jsonb; tenant text; who text; iss text; client text;
  app_id uuid; app_name text; requested text; r record; v_fields jsonb;
  collections jsonb := '[]'::jsonb;
BEGIN
  IF payload IS NULL OR jsonb_typeof(payload)<>'object' THEN
    RETURN jsonb_build_object('status',400,'error','invalid_storage_request');
  END IF;
  IF payload - ARRAY['application']::text[] <> '{}'::jsonb THEN
    RETURN jsonb_build_object('status',400,'error','invalid_storage_request');
  END IF;
  requested := payload->>'application';
  IF requested IS NULL OR requested !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
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

  SELECT a.app_id,a.display_name INTO app_id,app_name
    FROM app_private.applications a
    WHERE a.tenant_id=tenant AND a.issuer=iss AND a.app_id=requested::uuid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status',404,'error','application_not_found');
  END IF;

  FOR r IN
    SELECT ar.collection, count(*)::int AS records, max(ar.created_at) AS updated_at
      FROM core.app_records ar
      WHERE ar.tenant_id=tenant AND ar.owner_app_id=app_id
      GROUP BY ar.collection
      ORDER BY ar.collection
  LOOP
    WITH sample AS (
      SELECT ar.data
        FROM core.app_records ar
        WHERE ar.tenant_id=tenant AND ar.owner_app_id=app_id AND ar.collection=r.collection
        ORDER BY ar.created_at DESC, ar.id DESC
        LIMIT 200
    ), entries AS (
      SELECT e.key AS name, jsonb_typeof(e.value) AS kind
        FROM sample, LATERAL jsonb_each(sample.data) e
    ), agg AS (
      SELECT name,
        count(*) FILTER (WHERE kind <> 'null')::int AS filled,
        array_agg(DISTINCT kind) FILTER (WHERE kind <> 'null') AS kinds
        FROM entries
        GROUP BY name
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'name',agg.name,
        'type',CASE WHEN agg.kinds IS NULL THEN 'null'
                    WHEN array_length(agg.kinds,1)=1 THEN agg.kinds[1]
                    ELSE 'mixed' END,
        'fillRate',CASE WHEN s.sample_total=0 THEN 0
                        ELSE round(100.0*agg.filled/s.sample_total)::int END)
      ORDER BY agg.name),'[]'::jsonb)
      INTO v_fields
      FROM agg, (SELECT count(*)::int AS sample_total FROM sample) s;

    collections := collections || jsonb_build_array(jsonb_build_object(
      'name',r.collection,
      'records',r.records,
      'updatedAt',r.updated_at,
      'fields',v_fields));
  END LOOP;

  RETURN jsonb_build_object('status',200,'value',jsonb_build_object(
    'application',jsonb_build_object('id',app_id,'name',app_name),
    'collections',collections));
END $$;

RESET ROLE;
ALTER FUNCTION core.storage_collections(jsonb) OWNER TO junctura_app_owner;
REVOKE ALL ON FUNCTION core.storage_collections(jsonb) FROM PUBLIC,junctura_api,junctura_app_api,junctura_resource_api,junctura_audit_api,junctura_capability_api,junctura_trust_api,junctura_execution_api,junctura_composition_api,junctura_subject_api,junctura_directory_api,junctura_workflow_audit_api,junctura_storage_api;
GRANT EXECUTE ON FUNCTION core.storage_collections(jsonb) TO junctura_storage_collections_api;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES(26);
NOTIFY pgrst,'reload schema';
COMMIT;
