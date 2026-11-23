-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
-- Object metadata and the per-app file quota. An object keeps the identity of
-- the record it links to, including the record incarnation, so a deleted and
-- re-created record never presents a stale link (the bytes themselves are
-- retained). The quota charges the bytes of currently published versions under
-- a per-app transaction lock; legacy versions are backfilled from the Filer by
-- Core through 'missing'/'backfill' before the quota is charged for that app.
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

ALTER TABLE app_private.resource_objects
  ADD COLUMN record_collection text,
  ADD COLUMN record_id uuid,
  ADD COLUMN record_incarnation uuid,
  ADD COLUMN tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN size_bytes bigint;

ALTER TABLE app_private.resource_objects ADD CONSTRAINT resource_objects_link_shape CHECK (
  (record_collection IS NULL) = (record_id IS NULL) AND (record_id IS NULL) = (record_incarnation IS NULL)
  AND (record_collection IS NULL OR record_collection ~ '^[a-z][a-z0-9_-]{0,62}$')
  AND (size_bytes IS NULL OR size_bytes BETWEEN 1 AND 5242880));

CREATE INDEX resource_objects_tags_idx
  ON app_private.resource_objects USING gin (tags)
  WHERE deleted = false AND version IS NOT NULL;
CREATE INDEX resource_objects_record_ref_idx
  ON app_private.resource_objects (tenant_id, owner_app_id, record_collection, record_id, id)
  WHERE deleted = false AND version IS NOT NULL AND record_id IS NOT NULL;
CREATE INDEX resource_objects_published_idx
  ON app_private.resource_objects (tenant_id, owner_app_id, id)
  WHERE deleted = false AND version IS NOT NULL;

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
  size bigint;
  id uuid;
  version uuid;
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

  IF operation IN ('replay', 'prepare', 'commit') THEN
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
      jsonb_build_object('status', 200, 'value', to_jsonb(NULL)));
  END IF;

  IF operation IN ('prepare', 'commit') THEN
    id := (payload->>'id')::uuid;
    IF id IS NULL THEN RETURN object_error(400, 'invalid_request'); END IF;
    INSERT INTO app_private.resource_objects(tenant_id, id, owner_app_id) VALUES(tenant, id, actor)
      ON CONFLICT DO NOTHING;
    SELECT * INTO obj FROM app_private.resource_objects WHERE tenant_id=tenant AND id=id FOR UPDATE;
    IF NOT FOUND OR obj.deleted OR obj.owner_app_id <> actor THEN RETURN object_error(404, 'not_found'); END IF;
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
      'recordRef', CASE WHEN obj.record_id IS NULL THEN to_jsonb(NULL)
        ELSE jsonb_build_object('collection', obj.record_collection, 'id', obj.record_id) END));
  END IF;

  IF operation = 'commit' THEN
    size := (payload->>'size')::bigint;
    version := (payload->>'version')::uuid;
    IF size IS NULL OR size NOT BETWEEN 1 AND 5242880 OR version IS NULL
      OR coalesce(payload->>'status', '200') NOT IN ('200', '201')
      OR (payload - 'id' - 'version' - 'size' - 'status' - 'key' - 'digest' - 'method' - 'path'
          - 'recordRef' - 'tags') <> '{}'::jsonb
      OR (payload ? 'key' AND (coalesce(payload->>'digest', '') !~ '^[0-9a-f]{64}$'
        OR payload->>'method' IS NULL OR payload->>'path' IS NULL
        OR coalesce(payload->>'key', '') !~ '^[0-9a-f-]{36}$')) THEN
      RETURN object_error(400, 'invalid_request');
    END IF;
    IF payload ? 'recordRef' AND ref IS DISTINCT FROM 'null'::jsonb THEN
      -- The link is re-verified at commit: a record deleted (or replaced by a
      -- concurrent write) after prepare never publishes a dangling link.
      IF NOT EXISTS (SELECT FROM core.app_records r
          WHERE r.tenant_id=tenant AND r.owner_app_id=actor AND r.collection=ref->>'collection'
            AND r.id=(ref->>'id')::uuid) THEN
        RETURN object_error(404, 'not_found');
      END IF;
      SELECT r.incarnation INTO obj.record_incarnation FROM core.app_records r
        WHERE r.tenant_id=tenant AND r.owner_app_id=actor AND r.collection=ref->>'collection'
          AND r.id=(ref->>'id')::uuid;
      obj.record_collection := ref->>'collection'; obj.record_id := (ref->>'id')::uuid;
    ELSIF payload ? 'recordRef' THEN
      obj.record_collection := NULL; obj.record_id := NULL; obj.record_incarnation := NULL;
    END IF;
    IF payload ? 'tags' THEN obj.tags := coalesce(tags, '{}'); END IF;

    -- One charging decision per app at a time. The sum counts each currently
    -- published version exactly once; deleted objects never count.
    PERFORM pg_advisory_xact_lock(hashtextextended(
      jsonb_build_array('object-quota', tenant, actor)::text, 0));
    SELECT coalesce(sum(o.size_bytes), 0) INTO used FROM app_private.resource_objects o
      WHERE o.tenant_id=tenant AND o.owner_app_id=actor AND NOT o.deleted AND o.version IS NOT NULL;
    delta := size - coalesce(obj.size_bytes, 0);
    SELECT q.max_bytes INTO quota FROM app_private.object_quotas q
      WHERE q.tenant_id=tenant AND q.owner_app_id=actor;
    IF quota IS NOT NULL AND used + delta > quota THEN
      RETURN object_error(429, 'quota_exceeded', jsonb_build_object('quota',
        jsonb_build_object('resource', 'appFileBytes', 'limit', quota, 'used', used)));
    END IF;
    UPDATE app_private.resource_objects o SET version=version, size_bytes=size,
      record_collection=obj.record_collection, record_id=obj.record_id,
      record_incarnation=obj.record_incarnation, tags=obj.tags
      WHERE o.tenant_id=tenant AND o.id=id;
    result := jsonb_build_object('status', coalesce((payload->>'status')::integer, 200), 'value',
      jsonb_build_object('id', id, 'size', size, 'tags', to_jsonb(obj.tags),
        'recordRef', CASE WHEN obj.record_id IS NULL THEN to_jsonb(NULL)
          ELSE jsonb_build_object('collection', obj.record_collection, 'id', obj.record_id) END));
    IF payload ? 'key' THEN
      -- The receipt lock orders concurrent identical uploads: the loser replays
      -- the winner's committed result and removes its own published bytes.
      scope := record_caller_scope(actor);
      receipt := record_replay(scope, payload->>'method', payload->>'path',
        (payload->>'key')::uuid, decode(payload->>'digest', 'hex'));
      IF receipt IS NOT NULL THEN
        RETURN jsonb_build_object('replayed', true) || receipt;
      END IF;
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
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', o.id, 'size', o.size_bytes, 'tags', to_jsonb(o.tags),
        'recordRef', CASE WHEN o.record_id IS NULL THEN to_jsonb(NULL)
          WHEN object_link_valid(o.tenant_id, o.record_collection, o.record_id, o.record_incarnation)
          THEN jsonb_build_object('collection', o.record_collection, 'id', o.record_id) END)
        ORDER BY o.id), '[]'::jsonb) INTO items
    FROM (
      SELECT o.* FROM app_private.resource_objects o
      WHERE o.tenant_id=tenant AND NOT o.deleted AND o.version IS NOT NULL AND o.size_bytes IS NOT NULL
        AND core.resource_readable(o.owner_app_id, 'object', o.id)
        AND (ref IS NULL OR (o.record_collection=ref->>'collection' AND o.record_id=(ref->>'id')::uuid))
        AND (NOT payload ? 'tag' OR payload->>'tag'=ANY(o.tags))
        AND (payload->>'after' IS NULL OR o.id > (payload->>'after')::uuid)
      ORDER BY o.id LIMIT (payload->>'limit')::integer + 1
    ) o;
    RETURN jsonb_build_object('status', 200, 'value', items);
  END IF;

  IF operation = 'missing' THEN
    -- Published versions whose byte size PostgreSQL does not know yet; Core
    -- reads each size from the Filer and reports it back through 'backfill'.
    IF (payload - 'limit') <> '{}'::jsonb OR coalesce(payload->>'limit', '64') !~ '^[0-9]+$' THEN
      RETURN object_error(400, 'invalid_request');
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'version', o.version) ORDER BY o.id), '[]'::jsonb)
      INTO items
    FROM (
      SELECT o.id, o.version FROM app_private.resource_objects o
      WHERE o.tenant_id=tenant AND o.owner_app_id=actor AND NOT o.deleted
        AND o.version IS NOT NULL AND o.size_bytes IS NULL
      ORDER BY o.id LIMIT coalesce((payload->>'limit')::integer, 64)
    ) o;
    RETURN jsonb_build_object('status', 200, 'value', items);
  END IF;

  IF operation = 'backfill' THEN
    IF NOT core.resource_writer() THEN RETURN object_error(403, 'write_forbidden'); END IF;
    IF jsonb_typeof(payload->'sizes') IS DISTINCT FROM 'array' OR (payload - 'sizes') <> '{}'::jsonb THEN
      RETURN object_error(400, 'invalid_request');
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(
      jsonb_build_array('object-quota', tenant, actor)::text, 0));
    FOR ref IN SELECT * FROM jsonb_array_elements(payload->'sizes') LOOP
      IF jsonb_typeof(ref) IS DISTINCT FROM 'object' OR (ref - 'id' - 'version' - 'size') <> '{}'::jsonb
        OR (ref->>'id')::uuid IS NULL OR (ref->>'version')::uuid IS NULL
        OR (ref->>'size')::bigint IS NULL OR (ref->>'size')::bigint NOT BETWEEN 1 AND 5242880 THEN
        RETURN object_error(400, 'invalid_request');
      END IF;
      UPDATE app_private.resource_objects o SET size_bytes=(ref->>'size')::bigint
        WHERE o.tenant_id=tenant AND o.owner_app_id=actor AND o.id=(ref->>'id')::uuid
          AND o.version=(ref->>'version')::uuid AND o.size_bytes IS NULL;
    END LOOP;
    RETURN jsonb_build_object('status', 200, 'value', jsonb_build_object('backfilled', true));
  END IF;

  RETURN object_error(400, 'invalid_operation');
END $$;

REVOKE ALL ON FUNCTION app_private.object_error(integer,text,jsonb), app_private.object_tags_valid(text[]),
  app_private.object_link_valid(text,text,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION core.object_command(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.object_command(text, jsonb) TO junctura_resource_api;

RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (43);
NOTIFY pgrst, 'reload schema';
COMMIT;
