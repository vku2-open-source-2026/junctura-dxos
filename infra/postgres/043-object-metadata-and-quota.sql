-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
-- Object metadata and the per-app file quota. An object keeps the identity of
-- the record it links to, including the record incarnation, so a deleted and
-- re-created record never presents a stale link (the bytes themselves are
-- retained). The quota charges the bytes of currently published versions under
-- a per-app transaction lock. An internal reconciliation worker measures
-- versions the quota does not know yet and cleans staged upload attempts; a
-- commit refuses to charge while unmeasured versions remain, and every upload
-- records its candidate version before the Filer sees any bytes.
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='junctura_objects_worker') THEN
    CREATE ROLE junctura_objects_worker NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT junctura_objects_worker TO junctura_data;
GRANT USAGE ON SCHEMA core TO junctura_objects_worker;
SET LOCAL ROLE junctura_app_owner;

ALTER TABLE app_private.resource_objects
  ADD COLUMN record_collection text,
  ADD COLUMN record_id uuid,
  ADD COLUMN record_incarnation uuid,
  ADD COLUMN tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN size_bytes bigint,
  ADD COLUMN size_not_before timestamptz,
  ADD COLUMN size_attempts smallint NOT NULL DEFAULT 0;

ALTER TABLE app_private.resource_objects ADD CONSTRAINT resource_objects_link_shape CHECK (
  (record_collection IS NULL) = (record_id IS NULL) AND (record_id IS NULL) = (record_incarnation IS NULL)
  AND (record_collection IS NULL OR record_collection ~ '^[a-z][a-z0-9_-]{0,62}$')
  -- Zero is written only by the reconciliation worker for a version whose
  -- bytes no longer exist; such a version stays uncounted and unlisted.
  AND (size_bytes IS NULL OR size_bytes BETWEEN 0 AND 5242880));

CREATE INDEX resource_objects_tags_idx
  ON app_private.resource_objects USING gin (tags)
  WHERE deleted = false AND version IS NOT NULL;
CREATE INDEX resource_objects_record_ref_idx
  ON app_private.resource_objects (tenant_id, owner_app_id, record_collection, record_id, id)
  WHERE deleted = false AND version IS NOT NULL AND record_id IS NOT NULL;
CREATE INDEX resource_objects_published_idx
  ON app_private.resource_objects (tenant_id, owner_app_id, id)
  WHERE deleted = false AND version IS NOT NULL;

-- Upload attempts register the candidate version here before the Filer stores
-- bytes, so a lost commit response or a crashed Core always leaves an
-- operation the reconciliation worker can finish or clean up.
CREATE TABLE app_private.object_upload_staging (
  tenant_id text NOT NULL DEFAULT(current_setting('request.jwt.claims',true)::jsonb->>'tenant_id'),
  owner_app_id uuid NOT NULL,
  object_id uuid NOT NULL,
  version uuid NOT NULL,
  staged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  invalidated_at timestamptz,
  PRIMARY KEY(tenant_id,owner_app_id,object_id,version),
  FOREIGN KEY(tenant_id,owner_app_id) REFERENCES app_private.applications(tenant_id,app_id) ON DELETE CASCADE
);
ALTER TABLE app_private.object_upload_staging ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.object_upload_staging FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app_private.object_upload_staging TO junctura_app_owner
  USING(tenant_id=current_setting('request.jwt.claims',true)::jsonb->>'tenant_id')
  WITH CHECK(tenant_id=current_setting('request.jwt.claims',true)::jsonb->>'tenant_id');
REVOKE ALL ON app_private.object_upload_staging FROM PUBLIC;

CREATE TABLE app_private.object_quotas (
  tenant_id text NOT NULL DEFAULT(current_setting('request.jwt.claims',true)::jsonb->>'tenant_id'),
  owner_app_id uuid NOT NULL,
  max_bytes bigint NOT NULL CHECK(max_bytes >= 0),
  PRIMARY KEY(tenant_id,owner_app_id),
  FOREIGN KEY(tenant_id,owner_app_id) REFERENCES app_private.applications(tenant_id,app_id) ON DELETE CASCADE
);
ALTER TABLE app_private.object_quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.object_quotas FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app_private.object_quotas TO junctura_app_owner
  USING(tenant_id=current_setting('request.jwt.claims',true)::jsonb->>'tenant_id')
  WITH CHECK(tenant_id=current_setting('request.jwt.claims',true)::jsonb->>'tenant_id');
REVOKE ALL ON app_private.object_quotas FROM PUBLIC;

-- The reconciliation worker carries no tenant claims. Its discovery policies
-- allow only the cross-tenant reads inside core.object_maintenance; writes go
-- through statements that scope the local claims to one tenant at a time.
CREATE POLICY worker_discovery ON app_private.resource_objects FOR SELECT TO junctura_app_owner
  USING(current_setting('request.jwt.claims',true)::jsonb->>'role'='junctura_objects_worker'
    AND current_setting('request.jwt.claims',true)::jsonb->>'tenant_id' IS NULL);
CREATE POLICY worker_discovery ON app_private.object_upload_staging FOR SELECT TO junctura_app_owner
  USING(current_setting('request.jwt.claims',true)::jsonb->>'role'='junctura_objects_worker'
    AND current_setting('request.jwt.claims',true)::jsonb->>'tenant_id' IS NULL);

CREATE FUNCTION app_private.object_error(p_status integer, p_code text, p_details jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE sql SET search_path=pg_catalog AS $$
  SELECT CASE WHEN p_details IS NULL
    THEN jsonb_build_object('status', p_status, 'error', p_code)
    ELSE jsonb_build_object('status', p_status, 'error', p_code, 'details', p_details) END
$$;

CREATE FUNCTION app_private.object_tags_valid(p_tags text[]) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT p_tags IS NOT NULL AND cardinality(p_tags) <= 20 AND NOT EXISTS (
    SELECT FROM unnest(p_tags) AS t WHERE t IS NULL OR t !~ '^[a-z][a-z0-9_-]{0,63}$')
$$;

-- A record link is presented only while the linked record still exists with the
-- incarnation captured at upload time; a re-created record gets a new one.
CREATE FUNCTION app_private.object_link_valid(p_tenant text, p_collection text, p_id uuid, p_incarnation uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $$
  SELECT EXISTS(SELECT FROM core.app_records r
    WHERE r.tenant_id = p_tenant AND r.collection = p_collection
      AND r.id = p_id AND r.incarnation = p_incarnation)
$$;

CREATE FUNCTION core.object_command(operation text, payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private
SET lock_timeout='2s' SET timezone='UTC' AS $$
DECLARE
  claims jsonb := current_setting('request.jwt.claims', true)::jsonb;
  tenant text := claims->>'tenant_id';
  actor uuid := core.resource_actor();
  ref jsonb;
  tags text[];
  obj app_private.resource_objects;
  quota bigint;
  used bigint;
  delta bigint;
  next_size bigint;
  v_object_id uuid;
  next_version uuid;
  staged_version uuid;
  link_incarnation uuid;
  status integer;
  items jsonb;
  result jsonb;
  scope bytea;
  receipt jsonb;
BEGIN
  IF nullif(claims->>'client_id', '') IS NULL OR nullif(claims->>'sub', '') IS NULL
    OR nullif(claims->>'iss', '') IS NULL OR nullif(tenant, '') IS NULL THEN
    RETURN object_error(403, 'verified_client_required');
  END IF;
  IF actor IS NULL THEN RETURN object_error(403, 'application_access_required'); END IF;
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN RETURN object_error(400, 'invalid_request'); END IF;

  -- Metadata arrives either as an omitted key (preserve the previous value on
  -- replace), an explicit null (clear the link), an object (set the link) and
  -- for tags as an omitted key, an array or an explicit empty array. Node
  -- marks the omitted case by not sending the key at all, so "omitted" never
  -- merges with null or [].
  IF operation <> 'list' AND payload ? 'recordRef' THEN
    ref := payload->'recordRef';
    IF ref IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(ref) IS DISTINCT FROM 'object'
        OR (ref - 'collection' - 'id') <> '{}'::jsonb
        OR ref->>'collection' !~ '^[a-z][a-z0-9_-]{0,62}$'
        OR (ref->>'id')::uuid IS NULL) THEN
      RETURN object_error(400, 'invalid_request');
    END IF;
  END IF;
  IF operation <> 'list' AND payload ? 'tags' THEN
    IF jsonb_typeof(payload->'tags') IS DISTINCT FROM 'array' THEN RETURN object_error(400, 'invalid_request'); END IF;
    -- An explicit empty array is valid and clears the tags.
    tags := CASE WHEN jsonb_array_length(payload->'tags') = 0 THEN '{}'::text[]
      ELSE (SELECT array_agg(DISTINCT value ORDER BY value) FROM jsonb_array_elements_text(payload->'tags')) END;
    IF NOT object_tags_valid(tags) THEN RETURN object_error(400, 'invalid_request'); END IF;
    IF cardinality(tags) <> jsonb_array_length(payload->'tags') THEN
      RETURN object_error(400, 'invalid_request');
    END IF;
  END IF;

  IF operation IN ('replay', 'stage', 'prepare', 'commit') THEN
    IF NOT core.resource_writer() THEN RETURN object_error(403, 'write_forbidden'); END IF;
  END IF;

  IF operation = 'replay' THEN
    IF coalesce(payload->>'digest', '') !~ '^[0-9a-f]{64}$' OR payload->>'method' IS NULL
      OR payload->>'path' IS NULL OR coalesce(payload->>'key', '') !~ '^[0-9a-f-]{36}$'
      OR (payload - 'key' - 'digest' - 'method' - 'path') <> '{}'::jsonb THEN
      RETURN object_error(400, 'invalid_request');
    END IF;
    scope := record_caller_scope(actor);
    RETURN coalesce(record_replay(scope, payload->>'method', payload->>'path',
      (payload->>'key')::uuid, decode(payload->>'digest', 'hex')),
      jsonb_build_object('status', 200, 'value', 'null'::jsonb));
  END IF;

  IF operation = 'commit' THEN
    next_size := (payload->>'size')::bigint;
    next_version := (payload->>'version')::uuid;
    IF next_size IS NULL OR next_size NOT BETWEEN 1 AND 5242880 OR next_version IS NULL
      OR (payload - 'id' - 'version' - 'size' - 'key' - 'digest' - 'method' - 'path'
          - 'recordRef' - 'tags') <> '{}'::jsonb
      OR (payload ? 'key' AND (coalesce(payload->>'digest', '') !~ '^[0-9a-f]{64}$'
        OR payload->>'method' IS NULL OR payload->>'path' IS NULL
        OR coalesce(payload->>'key', '') !~ '^[0-9a-f-]{36}$')) THEN
      RETURN object_error(400, 'invalid_request');
    END IF;
    IF payload ? 'key' THEN
      -- A stored receipt answers before any write, so the loser of a
      -- concurrent identical upload replays the winner's committed result
      -- instead of republishing its own version.
      scope := record_caller_scope(actor);
      receipt := record_replay(scope, payload->>'method', payload->>'path',
        (payload->>'key')::uuid, decode(payload->>'digest', 'hex'));
      IF receipt IS NOT NULL THEN
        RETURN jsonb_build_object('replayed', true) || receipt;
      END IF;
    END IF;
    -- One charging decision per app at a time, taken before the object row is
    -- locked: the reconciliation worker follows the same lock order.
    PERFORM pg_advisory_xact_lock(hashtextextended(
      jsonb_build_array('object-quota', tenant, actor)::text, 0));
    -- The staging attempt must still exist and stay un-invalidated under this
    -- same lock: the reconciliation worker invalidates unconfirmed attempts
    -- under it before deleting their bytes, so a commit whose attempt was
    -- already invalidated can never publish into bytes the worker is about to
    -- delete.
    IF NOT EXISTS(SELECT FROM app_private.object_upload_staging s
        WHERE s.tenant_id=tenant AND s.owner_app_id=actor
          AND s.object_id=(payload->>'id')::uuid AND s.version=next_version
          AND s.invalidated_at IS NULL) THEN
      RETURN object_error(409, 'staging_conflict');
    END IF;
    -- Versions the reconciliation worker has not measured yet make the quota
    -- sum incomplete; refuse until the worker reports their sizes.
    IF EXISTS(SELECT FROM app_private.resource_objects o
        WHERE o.tenant_id=tenant AND o.owner_app_id=actor AND NOT o.deleted
          AND o.version IS NOT NULL AND o.size_bytes IS NULL) THEN
      RETURN object_error(503, 'quota_unmeasured');
    END IF;
    SELECT coalesce(sum(o.size_bytes), 0) INTO used FROM app_private.resource_objects o
      WHERE o.tenant_id=tenant AND o.owner_app_id=actor AND NOT o.deleted AND o.version IS NOT NULL;
  END IF;

  IF operation IN ('stage', 'prepare', 'commit') THEN
    v_object_id := (payload->>'id')::uuid;
    IF v_object_id IS NULL THEN RETURN object_error(400, 'invalid_request'); END IF;
    INSERT INTO app_private.resource_objects(tenant_id, id, owner_app_id) VALUES(tenant, v_object_id, actor)
      ON CONFLICT DO NOTHING;
    SELECT * INTO obj FROM app_private.resource_objects o
      WHERE o.tenant_id=tenant AND o.id=v_object_id FOR UPDATE;
    IF NOT FOUND OR obj.deleted OR obj.owner_app_id <> actor THEN RETURN object_error(404, 'not_found'); END IF;
  END IF;

  IF operation = 'stage' THEN
    -- The candidate version is recorded before the Filer stores any byte, so
    -- an interrupted upload always leaves an operation to reconcile.
    IF (payload - 'id' - 'version') <> '{}'::jsonb OR (payload->>'version')::uuid IS NULL THEN
      RETURN object_error(400, 'invalid_request');
    END IF;
    staged_version := (payload->>'version')::uuid;
    INSERT INTO app_private.object_upload_staging(tenant_id, owner_app_id, object_id, version, staged_at)
      VALUES (tenant, actor, v_object_id, staged_version, clock_timestamp())
      ON CONFLICT (tenant_id, owner_app_id, object_id, version)
      DO UPDATE SET staged_at=EXCLUDED.staged_at, invalidated_at=NULL;
    RETURN jsonb_build_object('status', 200, 'value',
      jsonb_build_object('id', v_object_id, 'version', staged_version));
  END IF;

  IF operation = 'prepare' THEN
    IF ref IS NOT NULL AND ref IS DISTINCT FROM 'null'::jsonb THEN
      IF NOT EXISTS (SELECT FROM core.app_records r
          WHERE r.tenant_id=tenant AND r.owner_app_id=actor AND r.collection=ref->>'collection'
            AND r.id=(ref->>'id')::uuid) THEN
        RETURN object_error(404, 'not_found');
      END IF;
    END IF;
    RETURN jsonb_build_object('status', 200, 'value', jsonb_build_object(
      'ownerAppId', obj.owner_app_id, 'version', obj.version, 'size', obj.size_bytes,
      'tags', to_jsonb(obj.tags),
      'recordRef', CASE WHEN obj.record_id IS NULL THEN 'null'::jsonb
        ELSE jsonb_build_object('collection', obj.record_collection, 'id', obj.record_id) END));
  END IF;

  IF operation = 'commit' THEN
    IF payload ? 'recordRef' AND ref IS DISTINCT FROM 'null'::jsonb THEN
      -- The link is re-verified and locked in one statement at commit: a
      -- record deleted (or replaced by a concurrent write) after prepare
      -- never publishes a dangling link, and the incarnation is read from the
      -- same locked snapshot.
      SELECT r.incarnation INTO link_incarnation FROM core.app_records r
        WHERE r.tenant_id=tenant AND r.owner_app_id=actor AND r.collection=ref->>'collection'
          AND r.id=(ref->>'id')::uuid
        FOR SHARE OF r;
      IF link_incarnation IS NULL THEN RETURN object_error(404, 'not_found'); END IF;
      obj.record_collection := ref->>'collection'; obj.record_id := (ref->>'id')::uuid;
      obj.record_incarnation := link_incarnation;
    ELSIF payload ? 'recordRef' THEN
      obj.record_collection := NULL; obj.record_id := NULL; obj.record_incarnation := NULL;
    END IF;
    IF payload ? 'tags' THEN obj.tags := coalesce(tags, '{}'); END IF;
    delta := next_size - coalesce(obj.size_bytes, 0);
    SELECT q.max_bytes INTO quota FROM app_private.object_quotas q
      WHERE q.tenant_id=tenant AND q.owner_app_id=actor;
    IF quota IS NOT NULL AND used + delta > quota THEN
      RETURN object_error(429, 'quota_exceeded', jsonb_build_object('quota',
        jsonb_build_object('resource', 'appFileBytes', 'limit', quota, 'used', used)));
    END IF;
    -- The base version decides created versus replaced under the row lock.
    status := CASE WHEN obj.version IS NULL THEN 201 ELSE 200 END;
    UPDATE app_private.resource_objects o SET version=next_version, size_bytes=next_size,
      record_collection=obj.record_collection, record_id=obj.record_id,
      record_incarnation=obj.record_incarnation, tags=obj.tags
      WHERE o.tenant_id=tenant AND o.id=v_object_id;
    DELETE FROM app_private.object_upload_staging s
      WHERE s.tenant_id=tenant AND s.owner_app_id=actor
        AND s.object_id=v_object_id AND s.version=next_version;
    result := jsonb_build_object('status', status, 'value',
      jsonb_build_object('id', v_object_id, 'size', next_size, 'tags', to_jsonb(obj.tags),
        'recordRef', CASE WHEN obj.record_id IS NULL
            OR NOT object_link_valid(tenant, obj.record_collection, obj.record_id, obj.record_incarnation)
          THEN 'null'::jsonb
          ELSE jsonb_build_object('collection', obj.record_collection, 'id', obj.record_id) END));
    IF payload ? 'key' THEN
      scope := record_caller_scope(actor);
      PERFORM record_save_replay(scope, payload->>'method', payload->>'path',
        (payload->>'key')::uuid, decode(payload->>'digest', 'hex'), result);
    END IF;
    RETURN result;
  END IF;

  IF operation = 'list' THEN
    IF (payload - 'recordRef' - 'tag' - 'limit' - 'after') <> '{}'::jsonb
      OR coalesce(payload->>'limit', '') !~ '^[0-9]+$' OR (payload->>'limit')::integer NOT BETWEEN 1 AND 100 THEN
      RETURN object_error(400, 'invalid_request');
    END IF;
    ref := payload->'recordRef';
    IF ref IS NOT NULL AND (jsonb_typeof(ref) IS DISTINCT FROM 'object'
        OR (ref - 'collection' - 'id') <> '{}'::jsonb
        OR ref->>'collection' !~ '^[a-z][a-z0-9_-]{0,62}$' OR (ref->>'id')::uuid IS NULL) THEN
      RETURN object_error(400, 'invalid_request');
    END IF;
    IF payload ? 'tag' AND (jsonb_typeof(payload->'tag') IS DISTINCT FROM 'string'
        OR payload->>'tag' !~ '^[a-z][a-z0-9_-]{0,63}$') THEN
      RETURN object_error(400, 'invalid_request');
    END IF;
    -- The recordRef filter reuses the exact incarnation predicate that the
    -- response presents, so an expired link filters like the null it shows.
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', o.id, 'size', o.size_bytes, 'tags', to_jsonb(o.tags),
        'recordRef', CASE WHEN o.record_id IS NULL THEN 'null'::jsonb
          WHEN object_link_valid(o.tenant_id, o.record_collection, o.record_id, o.record_incarnation)
          THEN jsonb_build_object('collection', o.record_collection, 'id', o.record_id) END)
        ORDER BY o.id), '[]'::jsonb) INTO items
    FROM (
      SELECT o.* FROM app_private.resource_objects o
      WHERE o.tenant_id=tenant AND NOT o.deleted AND o.version IS NOT NULL AND o.size_bytes > 0
        AND core.resource_readable(o.owner_app_id, 'object', o.id)
        AND (ref IS NULL OR (o.record_collection=ref->>'collection' AND o.record_id=(ref->>'id')::uuid
          AND object_link_valid(o.tenant_id, o.record_collection, o.record_id, o.record_incarnation)))
        AND (NOT payload ? 'tag' OR payload->>'tag'=ANY(o.tags))
        AND (payload->>'after' IS NULL OR o.id > (payload->>'after')::uuid)
      ORDER BY o.id LIMIT (payload->>'limit')::integer + 1
    ) o;
    RETURN jsonb_build_object('status', 200, 'value', items);
  END IF;

  RETURN object_error(400, 'invalid_operation');
END $$;

-- The reconciliation worker enumerates work across tenants without tenant
-- claims and scopes its writes to one tenant per statement. It measures
-- published versions from the Filer for the quota and finishes or cleans
-- staged upload attempts; it charges nothing and touches nothing else.
CREATE FUNCTION core.object_maintenance(operation text, payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private
SET lock_timeout='2s' SET timezone='UTC' AS $$
DECLARE
  claims jsonb := current_setting('request.jwt.claims', true)::jsonb;
  items jsonb;
  entry jsonb;
  written integer;
  changed integer := 0;
  tenant text;
  app uuid;
  published uuid;
BEGIN
  IF claims->>'role' IS DISTINCT FROM 'junctura_objects_worker' THEN
    RETURN object_error(403, 'worker_required');
  END IF;
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN RETURN object_error(400, 'invalid_request'); END IF;

  IF operation = 'unmeasured' THEN
    IF (payload - 'limit' - 'after') <> '{}'::jsonb OR coalesce(payload->>'limit', '256') !~ '^[0-9]+$'
      OR (payload->>'limit')::integer NOT BETWEEN 1 AND 256
      OR (payload ? 'after' AND (jsonb_typeof(payload->'after') IS DISTINCT FROM 'object'
        OR ((payload->'after') - 'tenantId' - 'appId' - 'id') <> '{}'::jsonb
        OR (payload->'after'->>'tenantId') !~ '^[a-z][a-z0-9-]{0,62}$'
        OR (payload->'after'->>'appId')::uuid IS NULL OR (payload->'after'->>'id')::uuid IS NULL)) THEN
      RETURN object_error(400, 'invalid_request');
    END IF;
    -- Keyset over (tenant, app, id) with a per-row retry schedule: rows the
    -- Filer could not measure back off and never hold the sweep head, so one
    -- failing batch cannot block the rows behind it or starve other tenants.
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'tenantId', o.tenant_id, 'appId', o.owner_app_id, 'id', o.id, 'version', o.version,
        'attempts', o.size_attempts)
        ORDER BY o.tenant_id, o.owner_app_id, o.id), '[]'::jsonb) INTO items
    FROM (
      SELECT o.tenant_id, o.owner_app_id, o.id, o.version, o.size_attempts FROM app_private.resource_objects o
      WHERE o.version IS NOT NULL AND o.size_bytes IS NULL AND NOT o.deleted
        AND (o.size_not_before IS NULL OR o.size_not_before<=clock_timestamp())
        AND (NOT payload ? 'after' OR (o.tenant_id, o.owner_app_id, o.id) >
          (payload->'after'->>'tenantId', (payload->'after'->>'appId')::uuid, (payload->'after'->>'id')::uuid))
      ORDER BY o.tenant_id, o.owner_app_id, o.id LIMIT coalesce((payload->>'limit')::integer, 256)
    ) o;
    RETURN jsonb_build_object('status', 200, 'value', items);
  END IF;

  IF operation = 'sizes' THEN
    IF jsonb_typeof(payload->'sizes') IS DISTINCT FROM 'array' OR (payload - 'sizes') <> '{}'::jsonb THEN
      RETURN object_error(400, 'invalid_request');
    END IF;
    FOR entry IN SELECT * FROM jsonb_array_elements(payload->'sizes') LOOP
      IF jsonb_typeof(entry) IS DISTINCT FROM 'object'
        OR (entry - 'tenantId' - 'appId' - 'id' - 'version' - 'size' - 'defer') <> '{}'::jsonb
        OR (entry->>'tenantId') !~ '^[a-z][a-z0-9-]{0,62}$' OR (entry->>'appId')::uuid IS NULL
        OR (entry->>'id')::uuid IS NULL OR (entry->>'version')::uuid IS NULL
        OR (entry ? 'size') = (entry ? 'defer')
        OR (entry ? 'defer' AND (jsonb_typeof(entry->'defer') IS DISTINCT FROM 'number'
          OR (entry->>'defer')::int IS NULL OR (entry->>'defer')::int NOT BETWEEN 1 AND 3600))
        OR (entry ? 'size' AND ((entry->>'size')::bigint IS NULL
          OR (entry->>'size')::bigint NOT BETWEEN 0 AND 5242880)) THEN
        RETURN object_error(400, 'invalid_request');
      END IF;
      tenant := entry->>'tenantId'; app := (entry->>'appId')::uuid;
      PERFORM set_config('request.jwt.claims',
        jsonb_build_object('role', claims->>'role', 'tenant_id', tenant)::text, true);
      IF entry ? 'defer' THEN
        -- An unmeasurable version backs off instead of occupying the sweep
        -- head; the next pass retries it after the defer window.
        UPDATE app_private.resource_objects o
          SET size_not_before=clock_timestamp()+make_interval(secs=>(entry->>'defer')::int),
            size_attempts=least(o.size_attempts+1, 32767)
          WHERE o.tenant_id=tenant AND o.owner_app_id=app AND o.id=(entry->>'id')::uuid
            AND o.version=(entry->>'version')::uuid AND o.size_bytes IS NULL AND NOT o.deleted;
      ELSE
        -- The same per-app lock orders measurement with the charging decision.
        PERFORM pg_advisory_xact_lock(hashtextextended(
          jsonb_build_array('object-quota', tenant, app)::text, 0));
        UPDATE app_private.resource_objects o SET size_bytes=(entry->>'size')::bigint,
          size_not_before=NULL, size_attempts=0
          WHERE o.tenant_id=tenant AND o.owner_app_id=app AND o.id=(entry->>'id')::uuid
            AND o.version=(entry->>'version')::uuid AND o.size_bytes IS NULL AND NOT o.deleted;
      END IF;
      GET DIAGNOSTICS written = ROW_COUNT;
      changed := changed + written;
    END LOOP;
    RETURN jsonb_build_object('status', 200, 'value', jsonb_build_object('measured', changed));
  END IF;

  IF operation = 'staged' THEN
    IF (payload - 'limit') <> '{}'::jsonb OR coalesce(payload->>'limit', '64') !~ '^[0-9]+$'
      OR (payload->>'limit')::integer NOT BETWEEN 1 AND 256 THEN
      RETURN object_error(400, 'invalid_request');
    END IF;
    -- Only attempts that had time to finish are reported; Core decides from
    -- the published version whether the staged bytes are still referenced.
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'tenantId', s.tenant_id, 'appId', s.owner_app_id, 'id', s.object_id,
        'stagedVersion', s.version, 'publishedVersion', o.version)
        ORDER BY s.tenant_id, s.owner_app_id, s.object_id, s.version), '[]'::jsonb) INTO items
    FROM (
      SELECT s.tenant_id, s.owner_app_id, s.object_id, s.version
        FROM app_private.object_upload_staging s
      WHERE s.staged_at < clock_timestamp() - interval '5 minutes'
      ORDER BY s.tenant_id, s.owner_app_id, s.object_id, s.version
      LIMIT coalesce((payload->>'limit')::integer, 64)
    ) s LEFT JOIN app_private.resource_objects o ON o.tenant_id=s.tenant_id AND o.id=s.object_id;
    RETURN jsonb_build_object('status', 200, 'value', items);
  END IF;

  IF operation = 'unstaged' THEN
    IF jsonb_typeof(payload->'items') IS DISTINCT FROM 'array'
      OR (payload - 'items' - 'cleared') <> '{}'::jsonb
      OR (payload ? 'cleared' AND jsonb_typeof(payload->'cleared') IS DISTINCT FROM 'boolean') THEN
      RETURN object_error(400, 'invalid_request');
    END IF;
    FOR entry IN SELECT * FROM jsonb_array_elements(payload->'items') LOOP
      IF jsonb_typeof(entry) IS DISTINCT FROM 'object'
        OR (entry - 'tenantId' - 'appId' - 'id' - 'stagedVersion') <> '{}'::jsonb
        OR (entry->>'tenantId') !~ '^[a-z][a-z0-9-]{0,62}$' OR (entry->>'appId')::uuid IS NULL
        OR (entry->>'id')::uuid IS NULL OR (entry->>'stagedVersion')::uuid IS NULL THEN
        RETURN object_error(400, 'invalid_request');
      END IF;
      tenant := entry->>'tenantId'; app := (entry->>'appId')::uuid;
      PERFORM set_config('request.jwt.claims',
        jsonb_build_object('role', claims->>'role', 'tenant_id', tenant)::text, true);
      IF coalesce(payload->>'cleared', 'false')::boolean THEN
        -- The bytes are gone: drop the invalidated attempt for good.
        DELETE FROM app_private.object_upload_staging s
          WHERE s.tenant_id=tenant AND s.owner_app_id=app
            AND s.object_id=(entry->>'id')::uuid AND s.version=(entry->>'stagedVersion')::uuid;
        GET DIAGNOSTICS written = ROW_COUNT;
        changed := changed + written;
      ELSE
        -- The invalidation takes the same per-app lock the charging commit
        -- uses, so a commit either published and removed its attempt first
        -- (nothing to invalidate) or sees the attempt invalidated and refuses
        -- to publish into the bytes about to be deleted.
        PERFORM pg_advisory_xact_lock(hashtextextended(
          jsonb_build_array('object-quota', tenant, app)::text, 0));
        PERFORM set_config('request.jwt.claims', jsonb_build_object('role', claims->>'role')::text, true);
        SELECT o.version INTO published FROM app_private.resource_objects o
          WHERE o.tenant_id=tenant AND o.id=(entry->>'id')::uuid;
        PERFORM set_config('request.jwt.claims',
          jsonb_build_object('role', claims->>'role', 'tenant_id', tenant)::text, true);
        UPDATE app_private.object_upload_staging s SET invalidated_at=coalesce(s.invalidated_at, clock_timestamp())
          WHERE s.tenant_id=tenant AND s.owner_app_id=app
            AND s.object_id=(entry->>'id')::uuid AND s.version=(entry->>'stagedVersion')::uuid;
        IF FOUND AND (published IS NULL OR published IS DISTINCT FROM (entry->>'stagedVersion')::uuid) THEN
          -- Only attempts the database still references are confirmed; the
          -- worker deletes their bytes, never the published version's.
          items := coalesce(items, '[]'::jsonb) || jsonb_build_array(entry);
          changed := changed + 1;
        END IF;
      END IF;
    END LOOP;
    RETURN jsonb_build_object('status', 200, 'value',
      jsonb_build_object('unstaged', changed, 'confirmed', coalesce(items, '[]'::jsonb)));
  END IF;

  RETURN object_error(400, 'invalid_operation');
END $$;

REVOKE ALL ON FUNCTION app_private.object_error(integer,text,jsonb), app_private.object_tags_valid(text[]),
  app_private.object_link_valid(text,text,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION core.object_command(text, jsonb), core.object_maintenance(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.object_command(text, jsonb) TO junctura_resource_api;
GRANT EXECUTE ON FUNCTION core.object_maintenance(text, jsonb) TO junctura_objects_worker;

RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (43);
NOTIFY pgrst, 'reload schema';
COMMIT;
