-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'junctura_record_api') THEN
    CREATE ROLE junctura_record_api NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT junctura_record_api TO junctura_data;
GRANT USAGE ON SCHEMA core TO junctura_record_api;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;

ALTER TABLE core.app_records
  ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 9007199254740991),
  ADD COLUMN incarnation uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN unique_key_value text COLLATE "C" CHECK (unique_key_value ~ '^[A-Za-z0-9_-]{1,128}$'),
  ADD CONSTRAINT app_records_scoped_id UNIQUE (tenant_id, owner_app_id, collection, id);
CREATE INDEX app_records_owner_collection_created_idx
  ON core.app_records (tenant_id, owner_app_id, collection, created_at, id);
CREATE UNIQUE INDEX app_records_unique_key_idx
  ON core.app_records (tenant_id, owner_app_id, collection, unique_key_value) WHERE unique_key_value IS NOT NULL;
REVOKE DELETE, INSERT (id, collection, data), UPDATE (data) ON core.app_records FROM junctura_resource_api;
DROP POLICY resource_insert ON core.app_records;
DROP POLICY resource_update ON core.app_records;
DROP POLICY resource_delete ON core.app_records;

SET LOCAL ROLE junctura_app_owner;
SET LOCAL search_path = pg_catalog, app_private;
CREATE TABLE app_private.record_collections (
  tenant_id text NOT NULL,
  owner_app_id uuid NOT NULL,
  collection text COLLATE "C" NOT NULL CHECK (collection ~ '^[a-z][a-z0-9_-]{0,62}$'),
  schema_doc jsonb,
  schema_revision bigint NOT NULL DEFAULT 0,
  indexed_fields text[] NOT NULL DEFAULT '{}',
  unique_key_field text,
  searchable_fields text[] NOT NULL DEFAULT '{}',
  sensitive_fields text[] NOT NULL DEFAULT '{}',
  record_count bigint NOT NULL DEFAULT 0 CHECK (record_count >= 0),
  max_records bigint CHECK (max_records BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (tenant_id, owner_app_id, collection),
  FOREIGN KEY (tenant_id, owner_app_id) REFERENCES app_private.applications (tenant_id, app_id) ON DELETE CASCADE
);
RESET ROLE;
INSERT INTO app_private.record_collections (tenant_id, owner_app_id, collection, record_count)
SELECT tenant_id, owner_app_id, collection, count(*) FROM core.app_records GROUP BY tenant_id, owner_app_id, collection;
SET LOCAL ROLE junctura_app_owner;
SET LOCAL search_path = pg_catalog, app_private;

CREATE TABLE app_private.record_field_values (
  tenant_id text NOT NULL,
  owner_app_id uuid NOT NULL,
  collection text COLLATE "C" NOT NULL,
  field text COLLATE "C" NOT NULL,
  record_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('number','string','boolean','date','date-time')),
  value jsonb NOT NULL,
  number_value numeric,
  datetime_value timestamptz,
  text_value text COLLATE "C",
  boolean_value boolean,
  PRIMARY KEY (tenant_id, owner_app_id, collection, field, record_id),
  FOREIGN KEY (tenant_id, owner_app_id, collection, record_id)
    REFERENCES core.app_records (tenant_id, owner_app_id, collection, id) ON DELETE CASCADE
);
CREATE FUNCTION app_private.record_text_digest(p_text text) RETURNS bytea
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
  SELECT sha256(convert_to(p_text, 'UTF8'))
$$;
CREATE INDEX record_field_scalar_idx ON app_private.record_field_values
  (tenant_id, owner_app_id, collection, field, kind, number_value, datetime_value, boolean_value, record_id)
  WHERE kind <> 'string';
CREATE INDEX record_field_text_prefix_idx ON app_private.record_field_values
  (tenant_id, owner_app_id, collection, field, (left(text_value, 256) COLLATE "C"), record_id)
  WHERE kind = 'string';
CREATE INDEX record_field_equality_idx ON app_private.record_field_values
  (tenant_id, owner_app_id, collection, field, (app_private.record_text_digest(text_value)), record_id)
  WHERE kind = 'string';

CREATE TABLE app_private.app_audit_actions (
  tenant_id text NOT NULL,
  app_id uuid NOT NULL,
  action text COLLATE "C" NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  sensitivity text NOT NULL CHECK (sensitivity IN ('standard', 'restricted')),
  visible_to_subject boolean NOT NULL,
  PRIMARY KEY (tenant_id, app_id, action),
  FOREIGN KEY (tenant_id, app_id) REFERENCES app_private.applications (tenant_id, app_id) ON DELETE CASCADE
);
CREATE TABLE app_private.record_read_grants (
  tenant_id text NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL,
  management_client text NOT NULL,
  owner_app_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, issuer, subject, management_client, owner_app_id),
  FOREIGN KEY (tenant_id, issuer, subject, management_client) REFERENCES app_private.principals ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, owner_app_id) REFERENCES app_private.applications (tenant_id, app_id) ON DELETE CASCADE
);
CREATE TABLE app_private.idempotency_results (
  tenant_id text NOT NULL,
  caller_scope bytea NOT NULL CHECK (octet_length(caller_scope) = 32),
  method text NOT NULL,
  concrete_path text NOT NULL,
  key uuid NOT NULL,
  digest bytea NOT NULL CHECK (octet_length(digest) = 32),
  status integer NOT NULL CHECK (status BETWEEN 200 AND 499),
  response_body jsonb NOT NULL,
  resource_headers jsonb,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, caller_scope, method, concrete_path, key)
);
CREATE INDEX idempotency_results_expiry_idx ON app_private.idempotency_results (tenant_id, expires_at);

DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['record_collections', 'record_field_values', 'app_audit_actions',
                                  'record_read_grants', 'idempotency_results'] LOOP
    EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('ALTER TABLE app_private.%I FORCE ROW LEVEL SECURITY', relation);
    EXECUTE format($policy$CREATE POLICY record_tenant_isolation ON app_private.%I TO junctura_app_owner
      USING (tenant_id = (current_setting('request.jwt.claims', true)::jsonb->>'tenant_id'))
      WITH CHECK (tenant_id = (current_setting('request.jwt.claims', true)::jsonb->>'tenant_id'))$policy$, relation);
  END LOOP;
END $$;

CREATE FUNCTION app_private.record_tenant() RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT current_setting('request.jwt.claims', true)::jsonb->>'tenant_id'
$$;

CREATE FUNCTION app_private.record_actor(p_lock boolean) RETURNS uuid
LANGUAGE plpgsql SET search_path = pg_catalog, app_private AS $$
DECLARE
  claims jsonb := current_setting('request.jwt.claims', true)::jsonb;
  actor uuid;
BEGIN
  IF NOT p_lock THEN RETURN core.resource_actor(); END IF;
  SELECT a.app_id INTO actor
    FROM applications a JOIN enrollments e USING (tenant_id, issuer, oauth_client_id, owner_subject, provider_origin)
    WHERE a.tenant_id = record_tenant() AND a.issuer = claims->>'iss' AND a.oauth_client_id = claims->>'client_id'
      AND e.resource_subject = claims->>'sub' AND e.enabled AND a.state = 'active'
    FOR SHARE OF a, e;
  RETURN actor;
END $$;

CREATE FUNCTION app_private.record_management_read(p_owner_app uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, app_private AS $$
  SELECT resource_app_active(p_owner_app) AND EXISTS (
    SELECT FROM record_read_grants g JOIN principals p USING (tenant_id, issuer, subject, management_client)
    WHERE g.tenant_id = record_tenant() AND g.owner_app_id = p_owner_app AND p.enabled
      AND g.issuer = current_setting('request.jwt.claims', true)::jsonb->>'iss'
      AND g.subject = current_setting('request.jwt.claims', true)::jsonb->>'sub'
      AND g.management_client = current_setting('request.jwt.claims', true)::jsonb->>'client_id')
$$;

CREATE FUNCTION app_private.record_read_scope(p_owner_app uuid, p_record_id uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, app_private AS $$
  SELECT CASE
    WHEN p_owner_app = core.resource_actor() THEN 'owner'
    WHEN core.resource_readable(p_owner_app, 'record', p_record_id) THEN 'shared'
    WHEN record_management_read(p_owner_app) THEN 'management'
  END
$$;

CREATE FUNCTION app_private.record_etag(p_tenant text, p_owner_app uuid, p_collection text,
    p_record_id uuid, p_incarnation uuid, p_version bigint) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
  SELECT format('"record-%s-%s"', encode(sha256(convert_to(
    jsonb_build_array(p_tenant, p_owner_app, p_collection, p_record_id, p_incarnation)::text, 'UTF8')), 'hex'), p_version)
$$;

CREATE FUNCTION app_private.record_time(p_kind text, p_text text) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
DECLARE parts text[];
BEGIN
  IF p_kind = 'date' THEN
    IF p_text COLLATE "C" !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN NULL; END IF;
    RETURN p_text::date::timestamp AT TIME ZONE 'UTC';
  END IF;
  parts := regexp_match(p_text COLLATE "C",
    '^([0-9]{4}-[0-9]{2}-[0-9]{2})[Tt](([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]+)?)([Zz]|([+-])([01][0-9]|2[0-3]):([0-5][0-9]))$');
  IF parts IS NULL THEN RETURN NULL; END IF;
  RETURN ((parts[1]::date + parts[2]::time) AT TIME ZONE 'UTC')
    - CASE WHEN parts[6] IS NULL THEN interval '0'
           ELSE (parts[6] || '1')::integer * make_interval(hours => parts[7]::integer, mins => parts[8]::integer) END;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;
END $$;

CREATE FUNCTION app_private.record_compact_bytes(p_data jsonb) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog, app_private AS $$
DECLARE result bigint;
BEGIN
  CASE jsonb_typeof(p_data)
    WHEN 'object' THEN
      SELECT 2 + coalesce(sum(octet_length(to_jsonb(key)::text) + 2 + record_compact_bytes(value)) - 1, 0)
        INTO result FROM jsonb_each(p_data);
    WHEN 'array' THEN
      SELECT 2 + coalesce(sum(record_compact_bytes(value) + 1) - 1, 0)
        INTO result FROM jsonb_array_elements(p_data);
    WHEN 'number' THEN result := octet_length(trim_scale(p_data::numeric)::text);
    ELSE result := octet_length(p_data::text);
  END CASE;
  RETURN result;
END $$;

CREATE FUNCTION app_private.record_issue(p_pointer text, p_keyword text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_array(jsonb_build_object('path', p_pointer, 'keyword', p_keyword))
$$;

CREATE FUNCTION app_private.record_pointer(p_path text, p_part text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
  SELECT p_path || '/' || replace(replace(p_part, '~', '~0'), '/', '~1')
$$;

CREATE FUNCTION app_private.record_schema_issues(p_schema jsonb, p_data jsonb, p_pointer text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, app_private AS $$
DECLARE
  kind text := jsonb_typeof(p_data);
  expected text := p_schema->>'type';
  child record;
  field text;
  issues jsonb;
  str text;
  num numeric;
  keyword text;
BEGIN
  IF p_schema IS NULL THEN RETURN '[]'; END IF;
  IF expected IS NOT NULL AND kind IS DISTINCT FROM expected AND
    NOT (expected = 'integer' AND CASE WHEN kind = 'number' THEN trunc(p_data::numeric) = p_data::numeric ELSE false END) THEN
    RETURN record_issue(p_pointer, 'type');
  END IF;
  IF p_schema ? 'enum' AND NOT EXISTS (SELECT FROM jsonb_array_elements(p_schema->'enum') AS choices(value) WHERE choices.value = p_data) THEN
    RETURN record_issue(p_pointer, 'enum');
  END IF;
  CASE kind
    WHEN 'object' THEN
      FOR field IN SELECT jsonb_array_elements_text(p_schema->'required') LOOP
        IF NOT p_data ? field THEN RETURN record_issue(record_pointer(p_pointer, field), 'required'); END IF;
      END LOOP;
      FOR child IN SELECT key, value FROM jsonb_each(p_schema->'properties') WHERE p_data ? key LOOP
        issues := record_schema_issues(child.value, p_data->child.key, record_pointer(p_pointer, child.key));
        IF issues <> '[]' THEN RETURN issues; END IF;
      END LOOP;
    WHEN 'array' THEN
      IF p_schema ? 'items' THEN
        FOR child IN SELECT value, ordinality FROM jsonb_array_elements(p_data) WITH ORDINALITY LOOP
          issues := record_schema_issues(p_schema->'items', child.value, record_pointer(p_pointer, (child.ordinality - 1)::text));
          IF issues <> '[]' THEN RETURN issues; END IF;
        END LOOP;
      END IF;
    WHEN 'string' THEN
      str := p_data #>> '{}';
      keyword := CASE
        WHEN char_length(str) < (p_schema->>'minLength')::numeric THEN 'minLength'
        WHEN char_length(str) > (p_schema->>'maxLength')::numeric THEN 'maxLength'
        WHEN str COLLATE "C" !~ (p_schema->>'pattern') THEN 'pattern'
        WHEN p_schema ? 'format' AND record_time(p_schema->>'format', str) IS NULL THEN 'format'
      END;
    WHEN 'number' THEN
      num := p_data::numeric;
      keyword := CASE
        WHEN num < -9007199254740992 OR num < (p_schema->>'minimum')::numeric THEN 'minimum'
        WHEN num > 9007199254740992 OR num > (p_schema->>'maximum')::numeric THEN 'maximum'
      END;
    ELSE NULL;
  END CASE;
  RETURN CASE WHEN keyword IS NOT NULL THEN record_issue(p_pointer, keyword) ELSE '[]'::jsonb END;
END $$;

CREATE FUNCTION app_private.record_compile_patterns(p_schema jsonb) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, app_private AS $$
DECLARE child jsonb;
BEGIN
  IF p_schema ? 'pattern' THEN PERFORM '' COLLATE "C" ~ (p_schema->>'pattern'); END IF;
  FOR child IN SELECT value FROM jsonb_each(p_schema->'properties') LOOP
    PERFORM record_compile_patterns(child);
  END LOOP;
  IF p_schema ? 'items' THEN PERFORM record_compile_patterns(p_schema->'items'); END IF;
END $$;

CREATE FUNCTION app_private.record_lock_collection(p_owner_app uuid, p_collection text) RETURNS app_private.record_collections
LANGUAGE plpgsql SET search_path = pg_catalog, app_private AS $$
DECLARE metadata app_private.record_collections;
BEGIN
  INSERT INTO record_collections (tenant_id, owner_app_id, collection)
    VALUES (record_tenant(), p_owner_app, p_collection) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT metadata FROM record_collections
    WHERE tenant_id = record_tenant() AND owner_app_id = p_owner_app AND collection = p_collection FOR UPDATE;
  RETURN metadata;
END $$;

CREATE FUNCTION app_private.record_replace_projection(p_record core.app_records) RETURNS void
LANGUAGE sql SET search_path = pg_catalog, app_private AS $$
  DELETE FROM record_field_values
    WHERE tenant_id = p_record.tenant_id AND owner_app_id = p_record.owner_app_id
      AND collection = p_record.collection AND record_id = p_record.id;
  INSERT INTO record_field_values
    (tenant_id, owner_app_id, collection, field, record_id, kind, value, number_value, datetime_value, text_value, boolean_value)
  SELECT m.tenant_id, m.owner_app_id, m.collection, field, p_record.id, kind, value,
    CASE WHEN kind = 'number' THEN value::numeric END,
    CASE WHEN kind IN ('date','date-time') THEN record_time(kind, value #>> '{}') END,
    CASE WHEN kind = 'string' THEN value #>> '{}' END,
    CASE WHEN kind = 'boolean' THEN value::boolean END
  FROM record_collections m
  CROSS JOIN LATERAL unnest(m.indexed_fields) AS fields(field)
  CROSS JOIN LATERAL (SELECT p_record.data->field AS value) v
  CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(value) = 'string'
    THEN coalesce(m.schema_doc->'properties'->field->>'format', 'string') ELSE jsonb_typeof(value) END AS kind) k
  WHERE m.tenant_id = p_record.tenant_id AND m.owner_app_id = p_record.owner_app_id
    AND m.collection = p_record.collection AND p_record.data ? field;
$$;

CREATE FUNCTION app_private.record_error(p_status integer, p_code text, p_details jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('status', p_status, 'error', p_code) ||
    CASE WHEN p_details IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('details', p_details) END
$$;

CREATE FUNCTION app_private.record_response(p_status integer, p_record core.app_records, p_scope text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, app_private AS $$
  SELECT jsonb_build_object('status', p_status, 'value', jsonb_build_object('id', p_record.id, 'collection',
    p_record.collection, 'created_at', p_record.created_at, 'version', p_record.version, 'data',
    CASE WHEN p_scope = 'management' THEN p_record.data - coalesce(
      (SELECT sensitive_fields FROM record_collections WHERE tenant_id = p_record.tenant_id
        AND owner_app_id = p_record.owner_app_id AND collection = p_record.collection), '{}'::text[])
    ELSE p_record.data END)) || CASE WHEN p_scope = 'owner' THEN jsonb_build_object('headers',
      jsonb_build_object('ETag', record_etag(p_record.tenant_id, p_record.owner_app_id, p_record.collection,
        p_record.id, p_record.incarnation, p_record.version))) ELSE '{}'::jsonb END
$$;

CREATE FUNCTION app_private.record_get(p_collection text, p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, app_private AS $$
  SELECT coalesce((
    SELECT record_response(200, r, scope)
    FROM core.app_records r CROSS JOIN LATERAL (SELECT record_read_scope(r.owner_app_id, r.id) AS scope) permission
    WHERE r.tenant_id = record_tenant() AND r.id = p_id AND r.collection = p_collection AND scope IS NOT NULL
  ), record_error(404, 'not_found'))
$$;

CREATE FUNCTION app_private.record_register(p_owner_app uuid, p_collection text, p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, app_private AS $$
DECLARE
  tenant text := record_tenant();
  unique_field text := p_body->>'uniqueKey';
  r core.app_records;
  catalog jsonb;
BEGIN
  PERFORM record_compile_patterns(p_body->'schema');
  -- A registration can change the app-wide audit catalog as well as its collection.
  PERFORM pg_advisory_xact_lock(hashtextextended('record-catalog:' || tenant || ':' || p_owner_app, 0));
  PERFORM record_lock_collection(p_owner_app, p_collection);
  IF EXISTS (
    SELECT FROM core.app_records ar WHERE ar.tenant_id = tenant AND ar.owner_app_id = p_owner_app AND ar.collection = p_collection
      AND (record_schema_issues(p_body->'schema', ar.data, '/data') <> '[]' OR
        (unique_field IS NOT NULL AND coalesce(ar.data->>unique_field, '') COLLATE "C" !~ '^[A-Za-z0-9_-]{1,128}$'))
  ) THEN RETURN record_error(409, 'resource_conflict'); END IF;
  IF unique_field IS NOT NULL AND EXISTS (
    SELECT FROM core.app_records ar WHERE ar.tenant_id = tenant AND ar.owner_app_id = p_owner_app AND ar.collection = p_collection
      GROUP BY (ar.data->>unique_field) COLLATE "C" HAVING count(*) > 1
  ) THEN RETURN record_error(409, 'unique_key_conflict'); END IF;

  UPDATE record_collections SET
    schema_doc = p_body->'schema', schema_revision = schema_revision + 1,
    indexed_fields = ARRAY(SELECT jsonb_array_elements_text(p_body->'indexed')), unique_key_field = unique_field,
    searchable_fields = ARRAY(SELECT jsonb_array_elements_text(p_body->'searchable')),
    sensitive_fields = ARRAY(SELECT jsonb_array_elements_text(p_body->'sensitive'))
  WHERE tenant_id = tenant AND owner_app_id = p_owner_app AND collection = p_collection;
  -- Clear old keys first, since values can move between rows when the configured field changes.
  UPDATE core.app_records SET unique_key_value = NULL
    WHERE tenant_id = tenant AND owner_app_id = p_owner_app AND collection = p_collection AND unique_key_value IS NOT NULL;
  FOR r IN UPDATE core.app_records SET unique_key_value = data->>unique_field
    WHERE tenant_id = tenant AND owner_app_id = p_owner_app AND collection = p_collection RETURNING *
  LOOP
    PERFORM record_replace_projection(r);
  END LOOP;
  IF p_body ? 'auditActions' THEN
    DELETE FROM app_audit_actions WHERE tenant_id = tenant AND app_id = p_owner_app;
    INSERT INTO app_audit_actions (tenant_id, app_id, action, sensitivity, visible_to_subject)
      SELECT tenant, p_owner_app, a->>'action', a->>'sensitivity', (a->>'visibleToSubject')::boolean
      FROM jsonb_array_elements(p_body->'auditActions') AS actions(a);
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('action', action, 'sensitivity', sensitivity,
    'visibleToSubject', visible_to_subject) ORDER BY action), '[]') INTO catalog
    FROM app_audit_actions WHERE tenant_id = tenant AND app_id = p_owner_app;
  RETURN jsonb_build_object('status', 200, 'value', p_body || jsonb_build_object('collection', p_collection, 'auditActions', catalog));
EXCEPTION WHEN invalid_regular_expression THEN
  RETURN record_error(400, 'invalid_schema');
END $$;

CREATE FUNCTION app_private.record_check_precondition(p_record core.app_records, p_if_match text, p_require_match boolean) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, app_private AS $$
BEGIN
  IF p_if_match IS NULL AND p_require_match THEN
    RETURN record_error(428, 'precondition_required');
  ELSIF p_if_match IS NOT NULL AND p_if_match <> record_etag(p_record.tenant_id, p_record.owner_app_id,
    p_record.collection, p_record.id, p_record.incarnation, p_record.version) THEN
    RETURN record_error(412, 'precondition_failed');
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION app_private.record_before_write(p_record core.app_records, p_if_match text, p_require_match boolean) RETURNS jsonb
LANGUAGE sql SET search_path = pg_catalog, app_private AS $$
  SELECT record_check_precondition(p_record, p_if_match, p_require_match)
$$;

CREATE FUNCTION app_private.record_next_data(p_record core.app_records, p_metadata app_private.record_collections,
    p_operation text, p_data jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('data', p_data)
$$;

CREATE FUNCTION app_private.record_write(p_operation text, p_owner_app uuid, p_collection text,
    p_record_id uuid, p_data jsonb, p_if_match text, p_require_match boolean) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, app_private AS $$
DECLARE
  tenant text := record_tenant();
  m app_private.record_collections;
  r core.app_records;
  result jsonb;
  data_new jsonb;
  issues jsonb;
  unique_value text;
  conflict_constraint text;
BEGIN
  IF p_owner_app IS NULL OR p_operation IS NULL OR p_operation NOT IN ('create','replace','delete','increment') THEN
    RETURN record_error(400, 'invalid_request');
  END IF;
  m := record_lock_collection(p_owner_app, p_collection);
  IF p_operation = 'create' AND p_record_id IS NOT NULL AND EXISTS (
      SELECT FROM core.app_records WHERE tenant_id = tenant AND id = p_record_id) THEN
    RETURN record_error(409, 'resource_conflict');
  END IF;
  IF p_operation <> 'create' THEN
    SELECT * INTO r FROM core.app_records WHERE tenant_id = tenant AND owner_app_id = p_owner_app
      AND collection = p_collection AND id = p_record_id FOR UPDATE;
    IF NOT FOUND THEN RETURN record_error(404, 'not_found'); END IF;
    result := record_before_write(r, p_if_match, p_require_match);
    IF result IS NOT NULL THEN RETURN result; END IF;
  END IF;
  IF p_operation = 'delete' THEN
    UPDATE resource_shares SET revoked = true
      WHERE tenant_id = tenant AND owner_app_id = p_owner_app AND resource_type = 'record' AND resource_id = r.id AND NOT revoked;
    DELETE FROM core.app_records WHERE tenant_id = tenant AND id = r.id;
    UPDATE record_collections SET record_count = record_count - 1
      WHERE tenant_id = tenant AND owner_app_id = p_owner_app AND collection = p_collection;
    RETURN jsonb_build_object('status', 204, 'value', NULL);
  END IF;

  result := record_next_data(r, m, p_operation, p_data);
  IF result ? 'error' THEN RETURN result; END IF;
  data_new := result->'data';
  IF jsonb_typeof(data_new) IS DISTINCT FROM 'object' THEN RETURN record_error(400, 'invalid_request'); END IF;
  IF record_compact_bytes(data_new) > 65536 THEN RETURN record_error(413, 'body_too_large'); END IF;
  issues := record_schema_issues(m.schema_doc, data_new, '/data');
  IF issues <> '[]' THEN RETURN record_error(422, 'schema_violation', jsonb_build_object('issues', issues)); END IF;
  IF m.unique_key_field IS NOT NULL THEN
    unique_value := data_new->>m.unique_key_field;
    IF coalesce(unique_value, '') COLLATE "C" !~ '^[A-Za-z0-9_-]{1,128}$' THEN
      RETURN record_error(422, 'schema_violation', jsonb_build_object('issues',
        record_issue(record_pointer('/data', m.unique_key_field), 'pattern')));
    END IF;
    IF EXISTS (SELECT FROM core.app_records WHERE tenant_id = tenant AND owner_app_id = p_owner_app
      AND collection = p_collection AND unique_key_value = unique_value AND id IS DISTINCT FROM r.id) THEN
      RETURN record_error(409, 'unique_key_conflict');
    END IF;
  END IF;
  IF p_operation = 'create' THEN
    IF m.max_records IS NOT NULL AND m.record_count >= m.max_records THEN
      RETURN record_error(429, 'quota_exceeded', jsonb_build_object('quota',
        jsonb_build_object('resource', 'collectionRecords', 'limit', m.max_records, 'used', m.record_count)));
    END IF;
    INSERT INTO core.app_records (tenant_id, owner_app_id, id, collection, data, unique_key_value)
      VALUES (tenant, p_owner_app, coalesce(p_record_id, gen_random_uuid()), p_collection, data_new, unique_value)
      RETURNING * INTO r;
    UPDATE record_collections SET record_count = record_count + 1
      WHERE tenant_id = tenant AND owner_app_id = p_owner_app AND collection = p_collection;
  ELSE
    IF r.version = 9007199254740991 THEN RETURN record_error(409, 'resource_conflict'); END IF;
    UPDATE core.app_records SET data = data_new, version = version + 1, unique_key_value = unique_value
      WHERE tenant_id = tenant AND id = r.id RETURNING * INTO r;
  END IF;
  PERFORM record_replace_projection(r);
  RETURN record_response(CASE WHEN p_operation = 'create' THEN 201 ELSE 200 END, r, 'owner');
EXCEPTION WHEN unique_violation THEN
  GET STACKED DIAGNOSTICS conflict_constraint = CONSTRAINT_NAME;
  IF conflict_constraint IN ('app_records_pkey', 'app_records_scoped_id') THEN RETURN record_error(409, 'resource_conflict'); END IF;
  IF conflict_constraint = 'app_records_unique_key_idx' THEN RETURN record_error(409, 'unique_key_conflict'); END IF;
  RAISE;
END $$;

CREATE FUNCTION app_private.record_caller_scope(p_actor uuid) RETURNS bytea
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT sha256(convert_to(jsonb_build_array(c->>'iss', c->>'sub', c->>'client_id', p_actor,
    c->>'delegated_sub')::text, 'UTF8'))
  FROM (SELECT current_setting('request.jwt.claims', true)::jsonb AS c) claims
$$;

CREATE FUNCTION app_private.record_replay(p_scope bytea, p_method text, p_path text,
    p_key uuid, p_digest bytea) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, app_private AS $$
DECLARE
  tenant text := record_tenant();
  receipt app_private.idempotency_results;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(
    'record-receipt', tenant, encode(p_scope, 'hex'), p_method, p_path, p_key)::text, 0));
  SELECT * INTO receipt FROM idempotency_results
    WHERE tenant_id = tenant AND caller_scope = p_scope AND method = p_method
      AND concrete_path = p_path AND key = p_key FOR UPDATE;
  IF FOUND AND receipt.expires_at > clock_timestamp() THEN
    IF receipt.digest <> p_digest THEN RETURN record_error(422, 'idempotency_key_reused'); END IF;
    RETURN jsonb_build_object('status', receipt.status) || receipt.response_body ||
      CASE WHEN receipt.resource_headers IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('headers', receipt.resource_headers) END;
  END IF;

  DELETE FROM idempotency_results WHERE tenant_id = tenant AND caller_scope = p_scope AND method = p_method
    AND concrete_path = p_path AND key = p_key;
  DELETE FROM idempotency_results WHERE (tenant_id, caller_scope, method, concrete_path, key) IN (
    SELECT tenant_id, caller_scope, method, concrete_path, key FROM idempotency_results
      WHERE tenant_id = tenant AND expires_at <= clock_timestamp()
      ORDER BY expires_at LIMIT 32 FOR UPDATE SKIP LOCKED
  );
  RETURN NULL;
END $$;

CREATE FUNCTION app_private.record_save_replay(p_scope bytea, p_method text, p_path text,
    p_key uuid, p_digest bytea, p_result jsonb) RETURNS void
LANGUAGE sql SET search_path = pg_catalog, app_private AS $$
  INSERT INTO idempotency_results (tenant_id, caller_scope, method, concrete_path, key, digest, status,
    response_body, resource_headers, created_at, expires_at)
  SELECT record_tenant(), p_scope, p_method, p_path, p_key, p_digest, (p_result->>'status')::integer,
    p_result - 'status' - 'headers', p_result->'headers', ts, ts + interval '24 hours'
  FROM (SELECT clock_timestamp() AS ts) recorded
$$;

CREATE FUNCTION app_private.record_apply(p_operation text, p_actor uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, app_private AS $$
BEGIN
  IF p_operation = 'register' THEN
    RETURN record_register(p_actor, p_payload->>'collection', p_payload->'body');
  END IF;
  IF p_operation NOT IN ('create','replace','delete') THEN RETURN record_error(400, 'invalid_request'); END IF;
  RETURN record_write(p_operation, p_actor, p_payload->>'collection', (p_payload->>'id')::uuid,
    p_payload->'body'->'data', p_payload->>'ifMatch', coalesce((p_payload->>'requireMatch')::boolean, false));
END $$;

CREATE FUNCTION core.record_command(operation text, payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app_private
SET lock_timeout = '2s' SET timezone = 'UTC' SET extra_float_digits = 1 AS $$
DECLARE
  claims jsonb := current_setting('request.jwt.claims', true)::jsonb;
  path text := payload->>'path';
  method text := payload->>'method';
  request_key uuid;
  request_digest bytea;
  scope bytea;
  actor uuid;
  result jsonb;
BEGIN
  IF nullif(claims->>'client_id', '') IS NULL OR nullif(claims->>'sub', '') IS NULL
    OR nullif(claims->>'iss', '') IS NULL OR nullif(record_tenant(), '') IS NULL THEN
    RETURN record_error(403, 'verified_client_required');
  END IF;
  IF operation = 'get' THEN
    result := record_get(payload->>'collection', (payload->>'id')::uuid);
    -- Compatibility keeps the application-binding error for callers without a management enrollment.
    IF result->>'error' = 'not_found' AND coalesce((payload->>'legacyBody')::boolean, false)
      AND core.resource_actor() IS NULL AND NOT EXISTS (
        SELECT FROM principals WHERE tenant_id = record_tenant() AND issuer = claims->>'iss'
          AND subject = claims->>'sub' AND management_client = claims->>'client_id' AND enabled
      ) THEN
      RETURN record_error(403, 'application_access_required');
    END IF;
    RETURN result;
  END IF;
  IF NOT core.resource_writer() THEN RETURN record_error(403, 'write_forbidden'); END IF;
  actor := record_actor(true);
  IF actor IS NULL THEN RETURN record_error(403, 'application_access_required'); END IF;
  IF payload->>'requestKey' IS NOT NULL THEN
    IF coalesce(payload->>'digest', '') !~ '^[0-9a-f]{64}$' OR path IS NULL OR method IS NULL THEN
      RETURN record_error(400, 'invalid_request');
    END IF;
    request_key := (payload->>'requestKey')::uuid;
    request_digest := decode(payload->>'digest', 'hex');
    scope := record_caller_scope(actor);
    result := record_replay(scope, method, path, request_key, request_digest);
    IF result IS NOT NULL THEN RETURN result; END IF;
  END IF;
  result := record_apply(operation, actor, payload);
  IF coalesce((payload->>'legacyBody')::boolean, false) AND result->'value' ? 'version' THEN
    result := jsonb_set(result, '{value}', (result->'value') - 'version');
  END IF;
  IF request_key IS NOT NULL THEN
    PERFORM record_save_replay(scope, method, path, request_key, request_digest, result);
  END IF;
  RETURN result;
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private FROM PUBLIC;
REVOKE ALL ON FUNCTION core.record_command(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.record_command(text, jsonb) TO junctura_record_api;
RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
ALTER ROLE junctura_record_api SET statement_timeout = '4s';
INSERT INTO core.schema_migrations(version) VALUES (30);
NOTIFY pgrst, 'reload schema';
COMMIT;
