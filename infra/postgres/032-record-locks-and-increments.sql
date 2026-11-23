-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
SET LOCAL ROLE junctura_app_owner;
SET LOCAL search_path = pg_catalog, app_private;

CREATE TABLE app_private.record_locks (
  tenant_id text NOT NULL,
  owner_app_id uuid NOT NULL,
  collection text COLLATE "C" NOT NULL,
  record_id uuid NOT NULL,
  lock_id uuid NOT NULL,
  holder_scope bytea NOT NULL CHECK (octet_length(holder_scope) = 32),
  locked_by text NOT NULL CHECK (char_length(locked_by) BETWEEN 1 AND 255),
  locked_until timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, record_id),
  FOREIGN KEY (tenant_id, owner_app_id, collection, record_id)
    REFERENCES core.app_records (tenant_id, owner_app_id, collection, id) ON DELETE CASCADE
);
ALTER TABLE app_private.record_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.record_locks FORCE ROW LEVEL SECURITY;
CREATE POLICY record_tenant_isolation ON app_private.record_locks TO junctura_app_owner
  USING (tenant_id = (current_setting('request.jwt.claims', true)::jsonb->>'tenant_id'))
  WITH CHECK (tenant_id = (current_setting('request.jwt.claims', true)::jsonb->>'tenant_id'));

CREATE FUNCTION app_private.record_lock_conflict(p_lock app_private.record_locks) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, app_private AS $$
  SELECT record_error(423, 'locked', jsonb_build_object('lockedBy', p_lock.locked_by, 'lockedUntil', p_lock.locked_until))
$$;

CREATE FUNCTION app_private.record_live_lock(p_record core.app_records, p_now timestamptz) RETURNS app_private.record_locks
LANGUAGE sql STABLE SET search_path = pg_catalog, app_private AS $$
  SELECT l.* FROM record_locks l WHERE l.tenant_id = p_record.tenant_id AND l.owner_app_id = p_record.owner_app_id
    AND l.collection = p_record.collection AND l.record_id = p_record.id AND l.locked_until > p_now
$$;

CREATE OR REPLACE FUNCTION app_private.record_before_write(p_record core.app_records, p_if_match text,
    p_require_match boolean) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, app_private AS $$
DECLARE lease app_private.record_locks := record_live_lock(p_record, clock_timestamp());
BEGIN
  IF lease.lock_id IS NOT NULL AND lease.holder_scope <> record_caller_scope(p_record.owner_app_id) THEN
    RETURN record_lock_conflict(lease);
  END IF;
  RETURN record_check_precondition(p_record, p_if_match, p_require_match);
END $$;

CREATE FUNCTION app_private.record_lock_command(p_actor uuid, p_collection text, p_id uuid,
    p_lock_id uuid, p_ttl integer, p_release boolean) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, app_private AS $$
DECLARE
  tenant text := record_tenant();
  scope bytea := record_caller_scope(p_actor);
  checked_at timestamptz;
  r core.app_records;
  lease app_private.record_locks;
  holder_name text;
BEGIN
  IF (p_release AND p_lock_id IS NULL) OR (NOT p_release AND (p_ttl IS NULL OR p_ttl NOT BETWEEN 1 AND 1800)) THEN
    RETURN record_error(400, 'invalid_request');
  END IF;
  PERFORM record_lock_collection(p_actor, p_collection);
  SELECT * INTO r FROM core.app_records WHERE tenant_id = tenant AND owner_app_id = p_actor
    AND collection = p_collection AND id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN record_error(404, 'not_found'); END IF;
  checked_at := clock_timestamp();
  lease := record_live_lock(r, checked_at);
  IF lease.lock_id IS NOT NULL AND lease.holder_scope <> scope THEN
    RETURN record_lock_conflict(lease);
  END IF;
  IF p_release THEN
    IF lease.lock_id IS NOT NULL AND lease.lock_id <> p_lock_id THEN RETURN record_error(409, 'resource_conflict'); END IF;
    DELETE FROM record_locks WHERE tenant_id = tenant AND record_id = p_id;
    RETURN jsonb_build_object('status', 204, 'value', NULL);
  END IF;

  IF p_lock_id IS NOT NULL THEN
    IF lease.lock_id IS DISTINCT FROM p_lock_id THEN RETURN record_error(409, 'resource_conflict'); END IF;
    UPDATE record_locks SET locked_until = checked_at + make_interval(secs => p_ttl)
      WHERE tenant_id = tenant AND record_id = p_id RETURNING * INTO lease;
  ELSIF lease.lock_id IS NULL THEN
    SELECT coalesce(nullif(left(btrim(current_setting('request.jwt.claims', true)::jsonb->>'display_name'), 255), ''),
      nullif(left(btrim(display_name), 255), ''), 'Application') INTO holder_name
      FROM applications WHERE tenant_id = tenant AND app_id = p_actor;
    INSERT INTO record_locks (tenant_id, owner_app_id, collection, record_id, lock_id, holder_scope, locked_by, locked_until)
      VALUES (tenant, p_actor, p_collection, p_id, gen_random_uuid(), scope, holder_name, checked_at + make_interval(secs => p_ttl))
      ON CONFLICT (tenant_id, record_id) DO UPDATE SET
        lock_id = EXCLUDED.lock_id, holder_scope = EXCLUDED.holder_scope, locked_by = EXCLUDED.locked_by, locked_until = EXCLUDED.locked_until
      RETURNING * INTO lease;
  END IF;
  RETURN jsonb_build_object('status', 200, 'value',
    jsonb_build_object('lockId', lease.lock_id, 'lockedUntil', lease.locked_until));
END $$;

CREATE OR REPLACE FUNCTION app_private.record_next_data(p_record core.app_records, p_metadata app_private.record_collections,
    p_operation text, p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, app_private AS $$
DECLARE
  result jsonb := p_record.data;
  item jsonb;
  field text;
  delta numeric;
  lower_bound numeric;
  upper_bound numeric;
  next_value numeric;
BEGIN
  IF p_operation <> 'increment' THEN RETURN jsonb_build_object('data', p_data); END IF;
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'array' THEN RETURN record_error(400, 'invalid_request'); END IF;
  IF jsonb_array_length(p_data) = 0 THEN RETURN record_error(400, 'invalid_request'); END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_data) LOOP
    field := item->>'field';
    IF field IS NULL OR NOT (field = ANY(p_metadata.indexed_fields)) OR
      jsonb_typeof(result->field) IS DISTINCT FROM 'number' OR
      jsonb_typeof(item->'by') IS DISTINCT FROM 'number' OR
      (item ? 'min' AND jsonb_typeof(item->'min') <> 'number') OR
      (item ? 'max' AND jsonb_typeof(item->'max') <> 'number') THEN
      RETURN record_error(400, 'invalid_request');
    END IF;
    delta := (item->>'by')::numeric;
    lower_bound := (item->>'min')::numeric;
    upper_bound := (item->>'max')::numeric;
    IF lower_bound > upper_bound THEN RETURN record_error(400, 'invalid_request'); END IF;
    next_value := (result->field)::numeric + delta;
    IF next_value < lower_bound OR next_value > upper_bound OR abs(next_value) > 9007199254740992 OR
      next_value <> next_value::double precision::text::numeric THEN
      RETURN record_error(409, 'limit_exceeded', jsonb_build_object('field', field));
    END IF;
    result := jsonb_set(result, ARRAY[field], to_jsonb(next_value));
  END LOOP;
  RETURN jsonb_build_object('data', result);
EXCEPTION WHEN numeric_value_out_of_range THEN
  RETURN record_error(409, 'limit_exceeded', jsonb_build_object('field', field));
END $$;

CREATE FUNCTION app_private.record_apply_single(p_operation text, p_actor uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, app_private AS $$
DECLARE
  collection text := p_payload->>'collection';
  id uuid := (p_payload->>'id')::uuid;
  body jsonb := p_payload->'body';
BEGIN
  CASE p_operation
    WHEN 'register' THEN RETURN record_register(p_actor, collection, body);
    WHEN 'lock' THEN RETURN record_lock_command(p_actor, collection, id, (body->>'lockId')::uuid,
      coalesce((body->>'ttlSeconds')::integer, 300), false);
    WHEN 'unlock' THEN RETURN record_lock_command(p_actor, collection, id, (p_payload->>'lockId')::uuid, NULL, true);
    WHEN 'increment' THEN RETURN record_write('increment', p_actor, collection, id, body->'operations', p_payload->>'ifMatch', false);
    ELSE
      IF p_operation NOT IN ('create','replace','delete') THEN RETURN record_error(400, 'invalid_request'); END IF;
      RETURN record_write(p_operation, p_actor, collection, id, body->'data', p_payload->>'ifMatch',
        coalesce((p_payload->>'requireMatch')::boolean, false));
  END CASE;
END $$;

CREATE OR REPLACE FUNCTION app_private.record_apply(p_operation text, p_actor uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE sql SET search_path = pg_catalog, app_private AS $$
  SELECT record_apply_single(p_operation, p_actor, p_payload)
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private FROM PUBLIC;
RESET ROLE;
INSERT INTO core.schema_migrations(version) VALUES (32);
NOTIFY pgrst, 'reload schema';
COMMIT;
