-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
GRANT USAGE ON SCHEMA core TO junctura_record_api;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

CREATE TABLE app_private.record_export_snapshots (
  tenant_id text NOT NULL,
  snapshot_id uuid NOT NULL DEFAULT gen_random_uuid(),
  caller_scope bytea NOT NULL CHECK (octet_length(caller_scope) = 32),
  owner_app_id uuid NOT NULL,
  collection text COLLATE "C" CHECK (collection IS NULL OR collection ~ '^[a-z][a-z0-9_-]{0,62}$'),
  line_count bigint NOT NULL DEFAULT 0 CHECK (line_count >= 0),
  byte_count bigint NOT NULL DEFAULT 0 CHECK (byte_count >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, snapshot_id),
  FOREIGN KEY (tenant_id, owner_app_id) REFERENCES app_private.applications (tenant_id, app_id) ON DELETE CASCADE
);
CREATE INDEX record_export_snapshot_expiry_idx ON app_private.record_export_snapshots (tenant_id, expires_at);

CREATE TABLE app_private.record_export_lines (
  tenant_id text NOT NULL,
  snapshot_id uuid NOT NULL,
  collection text COLLATE "C" NOT NULL CHECK (collection ~ '^[a-z][a-z0-9_-]{0,62}$'),
  record_id uuid NOT NULL,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  PRIMARY KEY (tenant_id, snapshot_id, collection, record_id),
  FOREIGN KEY (tenant_id, snapshot_id) REFERENCES app_private.record_export_snapshots (tenant_id, snapshot_id) ON DELETE CASCADE
);
ALTER TABLE app_private.record_export_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.record_export_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.record_export_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.record_export_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY record_tenant_isolation ON app_private.record_export_snapshots TO junctura_app_owner
  USING (tenant_id = (current_setting('request.jwt.claims', true)::jsonb->>'tenant_id'))
  WITH CHECK (tenant_id = (current_setting('request.jwt.claims', true)::jsonb->>'tenant_id'));
CREATE POLICY record_tenant_isolation ON app_private.record_export_lines TO junctura_app_owner
  USING (tenant_id = (current_setting('request.jwt.claims', true)::jsonb->>'tenant_id'))
  WITH CHECK (tenant_id = (current_setting('request.jwt.claims', true)::jsonb->>'tenant_id'));

CREATE FUNCTION app_private.record_export_start(p_actor uuid, p_collection text, p_scope bytea) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, app_private, pg_temp AS $$
DECLARE
  tenant text := record_tenant();
  snapshot uuid;
  snapshot_lines bigint;
  snapshot_bytes bigint;
  active_count integer;
  tenant_bytes bigint;
  max_snapshot_bytes constant bigint := 67108864;
  max_tenant_bytes constant bigint := 268435456;
  max_active constant integer := 2;
BEGIN
  IF p_collection IS NOT NULL AND p_collection !~ '^[a-z][a-z0-9_-]{0,62}$' THEN RETURN record_error(400, 'invalid_query'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('record_export:' || tenant, 0));
  DELETE FROM record_export_snapshots WHERE (tenant_id, snapshot_id) IN (
    SELECT tenant_id, snapshot_id FROM record_export_snapshots
      WHERE tenant_id = tenant AND expires_at <= clock_timestamp()
      ORDER BY expires_at LIMIT 32 FOR UPDATE SKIP LOCKED);
  SELECT count(*)::integer, coalesce(sum(byte_count), 0)::bigint INTO active_count, tenant_bytes
    FROM record_export_snapshots WHERE tenant_id = tenant;
  IF active_count >= max_active THEN
    RETURN record_error(429, 'quota_exceeded', jsonb_build_object('quota',
      jsonb_build_object('resource', 'exportSnapshots', 'limit', max_active, 'used', active_count)));
  END IF;
  SELECT count(*), coalesce(sum(app_private.record_compact_bytes(r.data)), 0)::bigint
    INTO snapshot_lines, snapshot_bytes
    FROM core.app_records r
    WHERE r.tenant_id = tenant AND r.owner_app_id = p_actor AND (p_collection IS NULL OR r.collection = p_collection);
  IF snapshot_bytes > max_snapshot_bytes OR tenant_bytes + snapshot_bytes > max_tenant_bytes THEN
    RETURN record_error(429, 'quota_exceeded', jsonb_build_object('quota',
      jsonb_build_object('resource', 'exportBytes', 'limit', max_tenant_bytes, 'used', tenant_bytes + snapshot_bytes)));
  END IF;
  INSERT INTO record_export_snapshots (tenant_id, caller_scope, owner_app_id, collection, line_count, byte_count, expires_at)
    VALUES (tenant, p_scope, p_actor, p_collection, snapshot_lines, snapshot_bytes, clock_timestamp() + interval '15 minutes')
    RETURNING snapshot_id INTO snapshot;
  INSERT INTO record_export_lines (tenant_id, snapshot_id, collection, record_id, data)
    SELECT tenant, snapshot, r.collection, r.id, r.data
    FROM core.app_records r
    WHERE r.tenant_id = tenant AND r.owner_app_id = p_actor AND (p_collection IS NULL OR r.collection = p_collection);
  RETURN jsonb_build_object('status', 200, 'value', jsonb_build_object('snapshotId', snapshot));
END $$;

CREATE FUNCTION app_private.record_export_page(p_snapshot uuid, p_scope bytea, p_after_collection text, p_after_id uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, app_private, pg_temp AS $$
DECLARE
  tenant text := record_tenant();
  page_json jsonb;
  next_after jsonb;
  valid boolean;
BEGIN
  IF p_snapshot IS NULL THEN RETURN record_error(400, 'invalid_request'); END IF;
  IF (p_after_collection IS NULL) <> (p_after_id IS NULL) THEN RETURN record_error(400, 'invalid_request'); END IF;
  IF p_after_collection IS NOT NULL AND p_after_collection !~ '^[a-z][a-z0-9_-]{0,62}$' THEN RETURN record_error(400, 'invalid_request'); END IF;
  DELETE FROM record_export_snapshots WHERE (tenant_id, snapshot_id) IN (
    SELECT tenant_id, snapshot_id FROM record_export_snapshots
      WHERE tenant_id = tenant AND expires_at <= clock_timestamp()
      ORDER BY expires_at LIMIT 32 FOR UPDATE SKIP LOCKED);
  WITH snapshot AS (
    SELECT s.snapshot_id FROM record_export_snapshots s
    WHERE s.tenant_id = tenant AND s.snapshot_id = p_snapshot
      AND s.caller_scope = p_scope AND s.expires_at > clock_timestamp()
  ), page AS (
    SELECT l.collection, l.record_id, l.data
    FROM record_export_lines l JOIN snapshot s USING (snapshot_id)
    WHERE l.tenant_id = tenant AND l.snapshot_id = p_snapshot
      AND (p_after_collection IS NULL OR (l.collection, l.record_id) > (p_after_collection, p_after_id))
    ORDER BY l.collection, l.record_id
    LIMIT 501
  ), trimmed AS (
    SELECT * FROM page ORDER BY collection, record_id LIMIT 500
  )
  SELECT (SELECT count(*) FROM snapshot) > 0,
    coalesce((SELECT jsonb_agg(jsonb_build_object('collection', collection, 'id', record_id, 'data', data)
      ORDER BY collection, record_id) FROM trimmed), '[]'::jsonb),
    CASE WHEN (SELECT count(*) FROM page) = 501 THEN
      (SELECT jsonb_build_object('collection', collection, 'id', record_id)
        FROM trimmed ORDER BY collection DESC, record_id DESC LIMIT 1)
    END
  INTO valid, page_json, next_after;
  IF NOT valid THEN RETURN record_error(404, 'not_found'); END IF;
  RETURN jsonb_build_object('status', 200, 'value', jsonb_build_object('lines', page_json, 'nextAfter', next_after));
END $$;

CREATE FUNCTION app_private.record_export_end(p_snapshot uuid, p_scope bytea) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, app_private, pg_temp AS $$
DECLARE
  tenant text := record_tenant();
BEGIN
  DELETE FROM record_export_snapshots WHERE (tenant_id, snapshot_id) IN (
    SELECT tenant_id, snapshot_id FROM record_export_snapshots
      WHERE tenant_id = tenant AND expires_at <= clock_timestamp()
      ORDER BY expires_at LIMIT 32 FOR UPDATE SKIP LOCKED);
  DELETE FROM record_export_snapshots WHERE tenant_id = tenant AND snapshot_id = p_snapshot AND caller_scope = p_scope;
  RETURN jsonb_build_object('status', 204, 'value', NULL);
END $$;

CREATE FUNCTION app_private.record_import(p_actor uuid, p_records jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, app_private, pg_temp AS $$
DECLARE
  tenant text := record_tenant();
  item jsonb;
  name text;
  result jsonb;
  failure jsonb;
  line_number integer := 0;
  created integer := 0;
BEGIN
  IF p_records IS NULL OR jsonb_typeof(p_records) <> 'array' THEN RETURN record_error(400, 'invalid_request'); END IF;
  BEGIN
    FOR name IN SELECT DISTINCT (value->>'collection') COLLATE "C" AS collection
      FROM jsonb_array_elements(p_records)
      WHERE jsonb_typeof(value) = 'object' AND value->>'collection' ~ '^[a-z][a-z0-9_-]{0,62}$'
      ORDER BY collection
    LOOP
      PERFORM record_lock_collection(p_actor, name);
    END LOOP;

    FOR item IN SELECT value FROM jsonb_array_elements(p_records) LOOP
      line_number := line_number + 1;
      IF jsonb_typeof(item) <> 'object' THEN
        failure := record_error(400, 'invalid_request', jsonb_build_object('issues',
          jsonb_build_array(jsonb_build_object('path', '', 'keyword', 'type', 'line', line_number))));
        RAISE EXCEPTION 'record_import_failed' USING ERRCODE = 'P0001';
      END IF;
      IF (SELECT count(*) FROM jsonb_object_keys(item)) <> 3 OR
          NOT (item ? 'collection') OR NOT (item ? 'id') OR NOT (item ? 'data') OR
          item->>'collection' !~ '^[a-z][a-z0-9_-]{0,62}$' OR
          item->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR
          jsonb_typeof(item->'data') <> 'object' THEN
        failure := record_error(400, 'invalid_request', jsonb_build_object('issues',
          jsonb_build_array(jsonb_build_object('path', '', 'keyword', 'properties', 'line', line_number))));
        RAISE EXCEPTION 'record_import_failed' USING ERRCODE = 'P0001';
      END IF;
      result := record_write('create', p_actor, item->>'collection', (item->>'id')::uuid, item->'data', NULL, false);
      IF result ? 'error' THEN
        IF result->>'error' = 'schema_violation' THEN
          failure := result || jsonb_build_object('details', jsonb_build_object('issues', coalesce((
            SELECT jsonb_agg(issue || jsonb_build_object('line', line_number))
            FROM jsonb_array_elements(result->'details'->'issues') issue), '[]'::jsonb)));
        ELSIF result->>'error' = 'invalid_request' THEN
          failure := result || jsonb_build_object('details', jsonb_build_object('issues',
            jsonb_build_array(jsonb_build_object('path', '', 'keyword', 'type', 'line', line_number))));
        ELSE
          failure := result || jsonb_build_object('details',
            coalesce(result->'details', '{}'::jsonb) || jsonb_build_object('line', line_number));
        END IF;
        RAISE EXCEPTION 'record_import_failed' USING ERRCODE = 'P0001';
      END IF;
      created := created + 1;
    END LOOP;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF failure IS NULL THEN RAISE; END IF;
    RETURN failure;
  END;
  RETURN jsonb_build_object('status', 200, 'value', jsonb_build_object('created', created));
END $$;

CREATE FUNCTION core.record_archive(operation text, payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app_private, pg_temp
SET lock_timeout = '2s' SET timezone = 'UTC' SET statement_timeout = '30s' AS $$
DECLARE
  claims jsonb := current_setting('request.jwt.claims', true)::jsonb;
  actor uuid;
  request_key uuid;
  request_digest bytea;
  scope bytea;
  result jsonb;
BEGIN
  IF nullif(claims->>'client_id', '') IS NULL OR nullif(claims->>'sub', '') IS NULL
    OR nullif(claims->>'iss', '') IS NULL OR nullif(record_tenant(), '') IS NULL THEN
    RETURN record_error(403, 'verified_client_required');
  END IF;
  IF operation = 'import' THEN
    IF NOT core.resource_writer() THEN RETURN record_error(403, 'write_forbidden'); END IF;
    actor := record_actor(true);
    IF actor IS NULL THEN RETURN record_error(403, 'application_access_required'); END IF;
    IF payload->>'requestKey' IS NOT NULL THEN
      IF coalesce(payload->>'digest', '') !~ '^[0-9a-f]{64}$' OR nullif(payload->>'path', '') IS NULL OR
          nullif(payload->>'method', '') IS NULL THEN RETURN record_error(400, 'invalid_request'); END IF;
      request_key := (payload->>'requestKey')::uuid;
      request_digest := decode(payload->>'digest', 'hex');
      scope := record_caller_scope(actor);
      result := record_replay(scope, payload->>'method', payload->>'path', request_key, request_digest);
      IF result IS NOT NULL THEN RETURN result; END IF;
    END IF;
    result := record_import(actor, payload->'records');
    IF request_key IS NOT NULL THEN
      PERFORM record_save_replay(scope, payload->>'method', payload->>'path', request_key, request_digest, result);
    END IF;
    RETURN result;
  END IF;
  actor := record_actor(false);
  IF actor IS NULL THEN RETURN record_error(403, 'application_access_required'); END IF;
  IF operation = 'export_start' THEN
    RETURN record_export_start(actor, nullif(payload->>'collection', ''), record_caller_scope(actor));
  ELSIF operation = 'export_page' THEN
    IF coalesce(payload->>'snapshotId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN record_error(400, 'invalid_request');
    END IF;
    RETURN record_export_page((payload->>'snapshotId')::uuid, record_caller_scope(actor),
      nullif(payload->>'afterCollection', ''), nullif(payload->>'afterId', '')::uuid);
  ELSIF operation = 'export_end' THEN
    IF coalesce(payload->>'snapshotId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN record_error(400, 'invalid_request');
    END IF;
    RETURN record_export_end((payload->>'snapshotId')::uuid, record_caller_scope(actor));
  END IF;
  RETURN record_error(400, 'invalid_request');
END $$;

REVOKE ALL ON FUNCTION app_private.record_export_start(uuid, text, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.record_export_page(uuid, bytea, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.record_export_end(uuid, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.record_import(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION core.record_archive(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.record_archive(text, jsonb) TO junctura_record_api;
RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (34);
NOTIFY pgrst, 'reload schema';
COMMIT;
