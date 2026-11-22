-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
-- Asynchronous search indexing. Every record write and every object
-- publication enqueues a job in the same transaction as the data change; the
-- Core worker drains the queue into Meilisearch over HTTP and deletes the job
-- only after the index task is confirmed. The ACL answer always comes from
-- PostgreSQL at query time: the index only ranks candidates.
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='junctura_search_worker') THEN
    CREATE ROLE junctura_search_worker NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT junctura_search_worker TO junctura_data;
GRANT USAGE ON SCHEMA core TO junctura_search_worker;
SET LOCAL ROLE junctura_app_owner;

CREATE TABLE app_private.search_index_jobs (
  tenant_id text NOT NULL,
  job_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  resource_type text NOT NULL CHECK(resource_type IN ('record','object')),
  resource_id uuid NOT NULL,
  owner_app_id uuid NOT NULL,
  collection text,
  reason text NOT NULL CHECK(reason IN ('upsert','delete')),
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE app_private.search_index_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.search_index_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app_private.search_index_jobs TO junctura_app_owner
  USING(tenant_id=current_setting('request.jwt.claims',true)::jsonb->>'tenant_id')
  WITH CHECK(tenant_id=current_setting('request.jwt.claims',true)::jsonb->>'tenant_id');
CREATE POLICY worker_claim ON app_private.search_index_jobs FOR SELECT TO junctura_app_owner
  USING(current_setting('request.jwt.claims',true)::jsonb->>'role'='junctura_search_worker');
CREATE POLICY worker_drop ON app_private.search_index_jobs FOR DELETE TO junctura_app_owner
  USING(current_setting('request.jwt.claims',true)::jsonb->>'role'='junctura_search_worker');
REVOKE ALL ON app_private.search_index_jobs FROM PUBLIC;

CREATE TABLE app_private.search_generations (
  tenant_id text NOT NULL PRIMARY KEY,
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE app_private.search_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.search_generations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app_private.search_generations TO junctura_app_owner
  USING(tenant_id=current_setting('request.jwt.claims',true)::jsonb->>'tenant_id')
  WITH CHECK(tenant_id=current_setting('request.jwt.claims',true)::jsonb->>'tenant_id');
REVOKE ALL ON app_private.search_generations FROM PUBLIC;

-- Queue writes share the writer's transaction through row triggers.
CREATE FUNCTION app_private.search_enqueue_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private AS $$
BEGIN
  INSERT INTO app_private.search_index_jobs(tenant_id, resource_type, resource_id, owner_app_id, collection, reason)
  VALUES (COALESCE(NEW.tenant_id, OLD.tenant_id), 'record', COALESCE(NEW.id, OLD.id),
    COALESCE(NEW.owner_app_id, OLD.owner_app_id), COALESCE(NEW.collection, OLD.collection),
    CASE WHEN TG_OP='DELETE' THEN 'delete' ELSE 'upsert' END);
  RETURN NULL;
END $$;
CREATE TRIGGER search_records_enqueue AFTER INSERT OR UPDATE OR DELETE ON core.app_records
  FOR EACH ROW EXECUTE FUNCTION app_private.search_enqueue_record();

-- Only published, clean object versions enter the queue; tombstones and
-- never-published rows enqueue a removal when a searchable version existed.
CREATE FUNCTION app_private.search_enqueue_object() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.deleted AND (TG_OP='INSERT' OR OLD.version IS NOT NULL)) THEN
    IF TG_OP='DELETE' AND OLD.version IS NULL THEN RETURN NULL; END IF;
    INSERT INTO app_private.search_index_jobs(tenant_id, resource_type, resource_id, owner_app_id, collection, reason)
    VALUES (COALESCE(NEW.tenant_id, OLD.tenant_id), 'object', COALESCE(NEW.id, OLD.id),
      COALESCE(NEW.owner_app_id, OLD.owner_app_id), NULL, 'delete');
    RETURN NULL;
  END IF;
  IF TG_OP='INSERT' OR NEW.version IS NULL THEN RETURN NULL; END IF;
  INSERT INTO app_private.search_index_jobs(tenant_id, resource_type, resource_id, owner_app_id, collection, reason)
  VALUES (NEW.tenant_id, 'object', NEW.id, NEW.owner_app_id, NULL, 'upsert');
  RETURN NULL;
END $$;
CREATE TRIGGER search_objects_enqueue AFTER INSERT OR UPDATE OR DELETE ON app_private.resource_objects
  FOR EACH ROW EXECUTE FUNCTION app_private.search_enqueue_object();

-- Objects mirror the record scopes without the management grant: ownership and
-- exact read shares decide visibility, record links never do.
CREATE FUNCTION app_private.search_object_scope(p_owner_app uuid, p_object_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $$
  SELECT CASE
    WHEN p_owner_app=core.resource_actor() THEN 'owner'
    WHEN core.resource_readable(p_owner_app, 'object', p_object_id) THEN 'shared'
  END
$$;

-- Cross-tenant worker and per-request ACL answers share one RPC. The worker
-- claims jobs, renders documents and confirms only after Meilisearch accepts
-- the index task; 'drop' removes the claimed job rows in the same role.
-- Cross-tenant worker and per-request ACL answers share one RPC. The worker
-- holds a per-tenant lease while draining, renders documents and confirms only
-- after Meilisearch accepts the index task; 'drop' removes the claimed job rows
-- in the same role. The lease keeps concurrent replicas from interleaving
-- renders of the same resource out of order.
CREATE TABLE app_private.search_worker_leases (
  tenant_id text PRIMARY KEY CHECK (tenant_id ~ '^[a-z][a-z0-9-]{0,62}$'),
  holder uuid NOT NULL,
  expires_at timestamptz NOT NULL
);
ALTER TABLE app_private.search_worker_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.search_worker_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY search_lease_tenant ON app_private.search_worker_leases TO junctura_app_owner
  USING (tenant_id = current_setting('request.jwt.claims',true)::jsonb->>'tenant_id')
  WITH CHECK (tenant_id = current_setting('request.jwt.claims',true)::jsonb->>'tenant_id');
CREATE POLICY search_lease_discovery ON app_private.search_worker_leases FOR SELECT TO junctura_app_owner
  USING (current_setting('request.jwt.claims',true)::jsonb->>'role' = 'junctura_search_worker');
REVOKE ALL ON app_private.search_worker_leases FROM PUBLIC;

CREATE FUNCTION core.search_command(operation text, payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private
SET lock_timeout='2s' SET timezone='UTC' AS $$
DECLARE
  claims jsonb := current_setting('request.jwt.claims', true)::jsonb;
  tenant text := claims->>'tenant_id';
  worker boolean := claims->>'role' = 'junctura_search_worker';
  items jsonb;
  generation uuid;
BEGIN
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('status', 400, 'error', 'invalid_request');
  END IF;
  -- Worker operations answer with the worker role and, for document rendering,
  -- a tenant-scoped token; interactive operations need a verified caller.
  IF operation IN ('jobs', 'drop', 'document') THEN
    IF NOT worker THEN RETURN jsonb_build_object('status', 403, 'error', 'worker_required'); END IF;
  ELSIF nullif(claims->>'iss', '') IS NULL OR nullif(claims->>'sub', '') IS NULL
    OR nullif(claims->>'client_id', '') IS NULL THEN
    RETURN jsonb_build_object('status', 403, 'error', 'verified_client_required');
  END IF;

  IF operation = 'tenants' THEN
    IF NOT worker OR payload <> '{}'::jsonb THEN
      RETURN jsonb_build_object('status', 403, 'error', 'worker_required');
    END IF;
    SELECT coalesce(jsonb_agg(DISTINCT j.tenant_id ORDER BY j.tenant_id), '[]'::jsonb) INTO items
      FROM app_private.search_index_jobs j;
    RETURN jsonb_build_object('status', 200, 'value', items);
  END IF;

  IF operation IN ('acquire', 'renew', 'release') THEN
    IF NOT worker OR coalesce(payload->>'lease', '') !~ '^[0-9a-f-]{36}$'
      OR (payload - 'lease') <> '{}'::jsonb OR (payload->>'lease')::uuid IS NULL THEN
      RETURN jsonb_build_object('status', 403, 'error', 'worker_required');
    END IF;
    IF operation = 'release' THEN
      DELETE FROM app_private.search_worker_leases l
        WHERE l.tenant_id=tenant AND l.holder=(payload->>'lease')::uuid;
      RETURN jsonb_build_object('status', 200, 'value', jsonb_build_object('released', true));
    END IF;
    IF operation = 'renew' THEN
      UPDATE app_private.search_worker_leases l SET expires_at=clock_timestamp() + interval '60 seconds'
        WHERE l.tenant_id=tenant AND l.holder=(payload->>'lease')::uuid AND l.expires_at > clock_timestamp();
      IF NOT FOUND THEN RETURN jsonb_build_object('status', 409, 'error', 'search_lease_lost'); END IF;
      RETURN jsonb_build_object('status', 200, 'value', jsonb_build_object('renewed', true));
    END IF;
    INSERT INTO app_private.search_worker_leases(tenant_id, holder, expires_at) VALUES (tenant, (payload->>'lease')::uuid, clock_timestamp() + interval '60 seconds')
      ON CONFLICT (tenant_id) DO UPDATE SET holder=EXCLUDED.holder, expires_at=EXCLUDED.expires_at
      WHERE app_private.search_worker_leases.expires_at < clock_timestamp();
    IF NOT FOUND THEN RETURN jsonb_build_object('status', 409, 'error', 'search_lease_busy'); END IF;
    RETURN jsonb_build_object('status', 200, 'value', jsonb_build_object('acquired', true));
  END IF;

  IF operation = 'jobs' THEN
    IF NOT worker OR (payload - 'limit') <> '{}'::jsonb
      OR coalesce(payload->>'limit', '32') !~ '^[0-9]+$' THEN
      RETURN jsonb_build_object('status', 403, 'error', 'worker_required');
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'tenant', j.tenant_id, 'jobId', j.job_id, 'reason', j.reason, 'kind', j.resource_type,
        'id', j.resource_id, 'ownerAppId', j.owner_app_id, 'collection', j.collection)
        ORDER BY j.job_id), '[]'::jsonb) INTO items
    FROM (
      SELECT * FROM app_private.search_index_jobs j
      WHERE claims->>'tenant_id' IS NULL OR j.tenant_id = claims->>'tenant_id'
      ORDER BY job_id
      LIMIT coalesce((payload->>'limit')::integer, 32)
    ) j;
    RETURN jsonb_build_object('status', 200, 'value', items);
  END IF;

  IF operation = 'drop' THEN
    IF NOT worker OR jsonb_typeof(payload->'jobIds') IS DISTINCT FROM 'array' THEN
      RETURN jsonb_build_object('status', 403, 'error', 'worker_required');
    END IF;
    DELETE FROM app_private.search_index_jobs j
      WHERE j.job_id = ANY (SELECT (value::text)::bigint FROM jsonb_array_elements(payload->'jobIds'));
    RETURN jsonb_build_object('status', 200, 'value', jsonb_build_object('dropped', true));
  END IF;

  IF tenant IS NULL OR tenant !~ '^[a-z][a-z0-9-]{0,62}$' THEN
    RETURN jsonb_build_object('status', 403, 'error', 'verified_client_required');
  END IF;

  IF operation = 'document' THEN
    -- The worker renders one candidate into an index document.
    IF NOT worker OR (payload - 'kind' - 'id') <> '{}'::jsonb
      OR payload->>'kind' NOT IN ('record','object') OR (payload->>'id')::uuid IS NULL THEN
      RETURN jsonb_build_object('status', 403, 'error', 'worker_required');
    END IF;
    IF payload->>'kind' = 'record' THEN
      SELECT jsonb_build_object('status', 200, 'value', jsonb_build_object(
          'kind', 'record', 'id', r.id, 'ownerAppId', r.owner_app_id, 'collection', r.collection,
          'version', r.version::text, 'incarnation', r.incarnation::text,
          'searchable', c.searchable_fields, 'sensitive', c.sensitive_fields, 'data', r.data))
        INTO items FROM core.app_records r
        LEFT JOIN app_private.record_collections c
          ON c.tenant_id=r.tenant_id AND c.owner_app_id=r.owner_app_id AND c.collection=r.collection
        WHERE r.tenant_id=tenant AND r.id=(payload->>'id')::uuid;
      RETURN coalesce(items, jsonb_build_object('status', 200, 'value', to_jsonb(NULL)));
    END IF;
    SELECT jsonb_build_object('status', 200, 'value', jsonb_build_object(
        'kind', 'object', 'id', o.id, 'ownerAppId', o.owner_app_id, 'version', o.version::text))
      INTO items FROM app_private.resource_objects o
      WHERE o.tenant_id=tenant AND o.id=(payload->>'id')::uuid
        AND NOT o.deleted AND o.version IS NOT NULL;
    RETURN coalesce(items, jsonb_build_object('status', 200, 'value', to_jsonb(NULL)));
  END IF;

  IF operation = 'acl' THEN
    -- Live tenant, ownership, share and grant checks on the current version;
    -- the index only proposes candidates. The answer carries the current
    -- generation so a stale search cursor fails closed.
    IF jsonb_typeof(payload->'candidates') IS DISTINCT FROM 'array'
      OR (payload - 'candidates') <> '{}'::jsonb THEN
      RETURN jsonb_build_object('status', 400, 'error', 'invalid_request');
    END IF;
    SELECT generation INTO generation FROM app_private.search_generations WHERE tenant_id=tenant;
    IF generation IS NULL THEN
      INSERT INTO app_private.search_generations(tenant_id) VALUES(tenant)
        ON CONFLICT (tenant_id) DO UPDATE SET generation=gen_random_uuid()
        RETURNING generation INTO generation;
    END IF;
    SELECT coalesce(jsonb_agg(CASE
        WHEN c.kind='record' THEN
          -- The incarnation in the candidate must match the live record: a
          -- deleted and re-created record with the same id and version never
          -- presents a stale index hit.
          CASE WHEN r.id IS NOT NULL AND r.version=(c.version)::bigint
               AND r.incarnation=(c.incarnation)::uuid
               AND cs.searchable_fields IS NOT NULL
               AND app_private.record_read_scope(r.owner_app_id, r.id) IS NOT NULL
          THEN jsonb_build_object('kind', 'record', 'id', r.id) END
        ELSE
          CASE WHEN o.id IS NOT NULL AND o.version=(c.version)::uuid
               AND app_private.search_object_scope(o.owner_app_id, o.id) IS NOT NULL
          THEN jsonb_build_object('kind', 'object', 'id', o.id) END
        END ORDER BY c.position), '[]'::jsonb)
      INTO items
    FROM jsonb_to_recordset(payload->'candidates')
      AS c(kind text, id uuid, version text, incarnation text, position integer)
    LEFT JOIN core.app_records r
      ON c.kind='record' AND r.tenant_id=tenant AND r.id=c.id
    LEFT JOIN app_private.record_collections cs
      ON cs.tenant_id=r.tenant_id AND cs.owner_app_id=r.owner_app_id AND cs.collection=r.collection
    LEFT JOIN app_private.resource_objects o
      ON c.kind='object' AND o.tenant_id=tenant AND o.id=c.id AND NOT o.deleted;
    RETURN jsonb_build_object('status', 200, 'value',
      jsonb_build_object('items', items, 'generation', generation));
  END IF;

  RETURN jsonb_build_object('status', 400, 'error', 'invalid_operation');
END $$;

REVOKE ALL ON FUNCTION app_private.search_enqueue_record(), app_private.search_enqueue_object(),
  app_private.search_object_scope(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION core.search_command(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.search_command(text, jsonb) TO junctura_resource_api, junctura_search_worker;

RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (44);
NOTIFY pgrst, 'reload schema';
COMMIT;
