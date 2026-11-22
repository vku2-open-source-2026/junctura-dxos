-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
GRANT USAGE ON SCHEMA core TO junctura_record_api;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

CREATE TABLE app_private.record_query_cursors (
  tenant_id text NOT NULL,
  cursor_id uuid NOT NULL DEFAULT gen_random_uuid(),
  caller_scope bytea NOT NULL CHECK (octet_length(caller_scope) = 32),
  owner_app_id uuid NOT NULL,
  collection text COLLATE "C" NOT NULL CHECK (collection ~ '^[a-z][a-z0-9_-]{0,62}$'),
  filters jsonb NOT NULL CHECK (jsonb_typeof(filters) = 'array'),
  sort text COLLATE "C" NOT NULL,
  schema_revision bigint NOT NULL CHECK (schema_revision >= 0),
  sort_key jsonb NOT NULL CHECK (jsonb_typeof(sort_key) = 'array' AND jsonb_array_length(sort_key) = 1),
  record_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, cursor_id),
  FOREIGN KEY (tenant_id, owner_app_id) REFERENCES app_private.applications (tenant_id, app_id) ON DELETE CASCADE
);
CREATE INDEX record_query_cursor_expiry_idx ON app_private.record_query_cursors (tenant_id, expires_at);
ALTER TABLE app_private.record_query_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.record_query_cursors FORCE ROW LEVEL SECURITY;
CREATE POLICY record_tenant_isolation ON app_private.record_query_cursors TO junctura_app_owner
  USING (tenant_id = (current_setting('request.jwt.claims', true)::jsonb->>'tenant_id'))
  WITH CHECK (tenant_id = (current_setting('request.jwt.claims', true)::jsonb->>'tenant_id'));

CREATE FUNCTION app_private.record_query_filters(p_filters jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN p_filters IS NULL OR jsonb_typeof(p_filters) <> 'array' THEN NULL
    ELSE (SELECT coalesce(jsonb_agg(f ORDER BY f->>'field'), '[]'::jsonb) FROM jsonb_array_elements(p_filters) f)
  END
$$;

CREATE FUNCTION app_private.record_query_term(p_kind text, p_op text, p_value jsonb, p_field text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, app_private, pg_temp AS $$
DECLARE
  text_value text;
  lookup text;
  escaped text;
  condition text;
BEGIN
  IF jsonb_typeof(p_value) = 'null' THEN
    IF p_op <> 'eq' THEN RETURN NULL; END IF;
    RETURN format('(r.data->%L IS NULL)', p_field);
  END IF;
  IF p_kind = 'string' THEN
    IF jsonb_typeof(p_value) <> 'string' THEN RETURN NULL; END IF;
    text_value := p_value #>> '{}';
    IF p_op = 'prefix' THEN
      IF text_value = '' THEN condition := 'f.kind = ''string''';
      ELSE
        -- The index expression only covers the first 256 characters. Escape that
        -- prefix for the index probe, then compare the full prefix on the source.
        lookup := left(text_value, 256);
        escaped := replace(replace(replace(lookup, '\', '\\'), '%', '\%'), '_', '\_');
        condition := format('f.kind = ''string'' AND left(f.text_value, 256) COLLATE "C" LIKE %L AND left(f.text_value, char_length(%L)) = %L COLLATE "C"', escaped || '%', text_value, text_value);
      END IF;
    ELSIF p_op = 'eq' THEN
      condition := format('f.kind = ''string'' AND app_private.record_text_digest(f.text_value) = app_private.record_text_digest(%L) AND f.text_value = %L COLLATE "C"', text_value, text_value);
    ELSIF p_op = 'gte' THEN
      condition := format('f.kind = ''string'' AND f.text_value >= %L COLLATE "C"', text_value);
    ELSIF p_op = 'lte' THEN
      condition := format('f.kind = ''string'' AND f.text_value <= %L COLLATE "C"', text_value);
    ELSE RETURN NULL;
    END IF;
  ELSIF p_kind = 'integer' THEN
    IF jsonb_typeof(p_value) <> 'number' OR p_op NOT IN ('eq', 'gte', 'lte') THEN RETURN NULL; END IF;
    text_value := p_value #>> '{}';
    IF (text_value)::numeric <> trunc((text_value)::numeric) THEN RETURN NULL; END IF;
    condition := format('f.kind = ''number'' AND f.number_value %s (%L)::numeric',
      CASE p_op WHEN 'eq' THEN '=' WHEN 'gte' THEN '>=' ELSE '<=' END, text_value);
  ELSIF p_kind = 'number' THEN
    IF jsonb_typeof(p_value) <> 'number' OR p_op NOT IN ('eq', 'gte', 'lte') THEN RETURN NULL; END IF;
    text_value := p_value #>> '{}';
    condition := format('f.kind = ''number'' AND f.number_value %s (%L)::numeric',
      CASE p_op WHEN 'eq' THEN '=' WHEN 'gte' THEN '>=' ELSE '<=' END, text_value);
  ELSIF p_kind = 'boolean' THEN
    IF jsonb_typeof(p_value) <> 'boolean' OR p_op <> 'eq' THEN RETURN NULL; END IF;
    condition := format('f.kind = ''boolean'' AND f.boolean_value = (%L)::boolean', p_value #>> '{}');
  ELSIF p_kind IN ('date', 'date-time') THEN
    IF jsonb_typeof(p_value) <> 'string' OR p_op NOT IN ('eq', 'gte', 'lte') THEN RETURN NULL; END IF;
    text_value := p_value #>> '{}';
    IF record_time(p_kind, text_value) IS NULL THEN RETURN NULL; END IF;
    condition := format('f.kind = %L AND f.datetime_value %s app_private.record_time(%L, %L)', p_kind,
      CASE p_op WHEN 'eq' THEN '=' WHEN 'gte' THEN '>=' ELSE '<=' END, p_kind, text_value);
  ELSE
    RETURN NULL;
  END IF;
  RETURN format('EXISTS (SELECT 1 FROM app_private.record_field_values f WHERE f.tenant_id = r.tenant_id AND f.owner_app_id = r.owner_app_id AND f.collection = r.collection AND f.record_id = r.id AND f.field = %L AND %s)', p_field, condition);
END $$;

CREATE FUNCTION app_private.record_query_predicate(p_filters jsonb, p_types jsonb, p_sensitive text[], p_management boolean) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, app_private, pg_temp AS $$
DECLARE
  filter jsonb;
  element jsonb;
  field text;
  operation text;
  kind text;
  term text;
  group_sql text;
  parts text[] := '{}';
BEGIN
  IF p_filters IS NULL THEN p_filters := '[]'; END IF;
  IF jsonb_typeof(p_filters) <> 'array' OR p_types IS NULL THEN RETURN record_error(400, 'invalid_query'); END IF;
  FOR filter IN SELECT value FROM jsonb_array_elements(p_filters) LOOP
    IF jsonb_typeof(filter) <> 'object' THEN RETURN record_error(400, 'invalid_query'); END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(filter)) <> 3 OR
        NOT (filter ? 'field') OR NOT (filter ? 'op') OR NOT (filter ? 'value') THEN RETURN record_error(400, 'invalid_query'); END IF;
    field := filter->>'field';
    operation := filter->>'op';
    IF field IS NULL OR field !~ '^[A-Za-z_][A-Za-z0-9_]{0,63}$' OR NOT (p_types ? field) OR
        operation IS NULL OR operation NOT IN ('eq', 'in', 'gte', 'lte', 'prefix') THEN RETURN record_error(400, 'invalid_query'); END IF;
    IF coalesce(p_management, false) AND field = ANY(coalesce(p_sensitive, '{}'::text[])) THEN RETURN record_error(400, 'invalid_query'); END IF;
    kind := p_types->>field;
    IF (operation = 'prefix' AND kind <> 'string') OR (operation IN ('gte', 'lte') AND kind = 'boolean') THEN RETURN record_error(400, 'invalid_query'); END IF;
    IF operation = 'in' THEN
      IF jsonb_typeof(filter->'value') <> 'array' OR jsonb_array_length(filter->'value') = 0 THEN RETURN record_error(400, 'invalid_query'); END IF;
      group_sql := '';
      FOR element IN SELECT value FROM jsonb_array_elements(filter->'value') LOOP
        term := record_query_term(kind, 'eq', element, field);
        IF term IS NULL THEN RETURN record_error(400, 'invalid_query'); END IF;
        group_sql := group_sql || CASE WHEN group_sql = '' THEN '' ELSE ' OR ' END || term;
      END LOOP;
      parts := array_append(parts, '(' || group_sql || ')');
    ELSE
      term := record_query_term(kind, operation, filter->'value', field);
      IF term IS NULL THEN RETURN record_error(400, 'invalid_query'); END IF;
      parts := array_append(parts, term);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('sql', coalesce(nullif(array_to_string(parts, ' AND '), ''), 'TRUE'));
END $$;

CREATE FUNCTION app_private.record_query_metadata(p_owner_app uuid, p_collection text, p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, app_private, pg_temp AS $$
DECLARE
  tenant text := record_tenant();
  schema_doc jsonb;
  revision bigint := 0;
  indexed text[] := '{}';
  sensitive text[] := '{}';
  unique_key text;
  types jsonb := '{}'::jsonb;
BEGIN
  IF p_owner_app IS NULL OR NOT resource_app_active(p_owner_app) THEN RETURN record_error(404, 'not_found'); END IF;
  IF p_owner_app IS DISTINCT FROM p_actor AND NOT record_management_read(p_owner_app) AND NOT EXISTS (
      SELECT FROM core.app_records r
      WHERE r.tenant_id = tenant AND r.owner_app_id = p_owner_app AND r.collection = p_collection
        AND core.resource_readable(p_owner_app, 'record', r.id)) THEN
    RETURN record_error(404, 'not_found');
  END IF;
  SELECT m.schema_doc, m.schema_revision, m.indexed_fields, m.sensitive_fields, m.unique_key_field
    INTO schema_doc, revision, indexed, sensitive, unique_key
    FROM app_private.record_collections m
    WHERE m.tenant_id = tenant AND m.owner_app_id = p_owner_app AND m.collection = p_collection;
  IF NOT FOUND THEN
    schema_doc := NULL; revision := 0; indexed := '{}'; sensitive := '{}'; unique_key := NULL;
  END IF;
  SELECT coalesce(jsonb_object_agg(field, CASE
      WHEN schema_doc->'properties'->field->>'type' = 'boolean' THEN 'boolean'
      WHEN schema_doc->'properties'->field->>'type' = 'integer' THEN 'integer'
      WHEN schema_doc->'properties'->field->>'type' = 'number' THEN 'number'
      WHEN schema_doc->'properties'->field->>'format' = 'date' THEN 'date'
      WHEN schema_doc->'properties'->field->>'format' = 'date-time' THEN 'date-time'
      ELSE 'string' END), '{}'::jsonb)
    INTO types FROM unnest(indexed) field;
  RETURN jsonb_build_object('status', 200, 'value', jsonb_build_object(
    'ownerAppId', p_owner_app,
    'collection', p_collection,
    'schemaRevision', revision,
    'indexed', to_jsonb(indexed),
    'sensitive', to_jsonb(sensitive),
    'uniqueKey', unique_key,
    'management', p_owner_app IS DISTINCT FROM p_actor AND record_management_read(p_owner_app),
    'types', types));
END $$;

CREATE FUNCTION app_private.record_query_list_read(p_actor uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, app_private, pg_temp SET timezone = 'UTC' AS $$
#variable_conflict use_variable
DECLARE
  tenant text := record_tenant();
  owner uuid;
  collection text;
  meta jsonb;
  types jsonb;
  sensitive text[];
  management boolean;
  revision bigint;
  limit_text text;
  page_limit integer;
  order_text text;
  sort_payload jsonb;
  sort_field text;
  sort_direction text;
  sort_kind text;
  sort_text text;
  sort_join text := '';
  sort_expression text := 'r.created_at';
  filter_set jsonb;
  predicate jsonb;
  predicate_sql text;
  cursor_text text;
  cursor_row app_private.record_query_cursors;
  cursor_sql text := '';
  from_sql text;
  where_sql text;
  order_sql text;
  query text;
  items jsonb := '[]'::jsonb;
  record_row record;
  data_out jsonb;
  item_count integer := 0;
  has_more boolean := false;
  last_key jsonb;
  last_id uuid;
  state jsonb;
  caller bytea := record_caller_scope(p_actor);
  comparison text;
  cursor_value text;
BEGIN
  owner := nullif(p_payload->>'ownerAppId', '')::uuid;
  owner := coalesce(owner, p_actor);
  collection := p_payload->>'collection';
  IF collection IS NULL OR collection !~ '^[a-z][a-z0-9_-]{0,62}$' THEN RETURN record_error(400, 'invalid_query'); END IF;
  meta := record_query_metadata(owner, collection, p_actor);
  IF meta ? 'error' THEN RETURN meta; END IF;
  types := meta->'value'->'types';
  sensitive := ARRAY(SELECT jsonb_array_elements_text(meta->'value'->'sensitive'));
  management := (meta->'value'->>'management')::boolean;
  revision := (meta->'value'->>'schemaRevision')::bigint;

  limit_text := coalesce(p_payload->>'limit', '100');
  IF limit_text !~ '^[0-9]+$' OR length(limit_text) > 3 OR limit_text::integer < 1 OR limit_text::integer > 100 THEN
    RETURN record_error(400, 'invalid_query');
  END IF;
  page_limit := limit_text::integer;
  order_text := coalesce(p_payload->>'order', 'asc');
  IF order_text NOT IN ('asc', 'desc') THEN RETURN record_error(400, 'invalid_query'); END IF;

  sort_payload := p_payload->'sort';
  IF sort_payload IS NULL OR sort_payload = 'null'::jsonb THEN
    sort_text := 'system.created_at.' || order_text;
  ELSE
    IF jsonb_typeof(sort_payload) <> 'object' THEN RETURN record_error(400, 'invalid_query'); END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(sort_payload)) <> 2 OR
        NOT (sort_payload ? 'field') OR NOT (sort_payload ? 'direction') THEN RETURN record_error(400, 'invalid_query'); END IF;
    sort_field := sort_payload->>'field';
    sort_direction := sort_payload->>'direction';
    IF sort_field IS NULL OR sort_field !~ '^[A-Za-z_][A-Za-z0-9_]{0,63}$' OR NOT (types ? sort_field) OR
        sort_direction NOT IN ('asc', 'desc') THEN RETURN record_error(400, 'invalid_query'); END IF;
    IF management AND sort_field = ANY(sensitive) THEN RETURN record_error(400, 'invalid_query'); END IF;
    sort_kind := types->>sort_field;
    sort_text := 'data.' || sort_field || '.' || sort_direction;
    sort_join := format('LEFT JOIN LATERAL (SELECT f.value, f.number_value, f.datetime_value, f.text_value, f.boolean_value FROM app_private.record_field_values f WHERE f.tenant_id = r.tenant_id AND f.owner_app_id = r.owner_app_id AND f.collection = r.collection AND f.record_id = r.id AND f.field = %L) sv ON TRUE', sort_field);
    sort_expression := CASE sort_kind
      WHEN 'number' THEN 'sv.number_value'
      WHEN 'integer' THEN 'sv.number_value'
      WHEN 'boolean' THEN 'sv.boolean_value'
      WHEN 'date' THEN 'sv.datetime_value'
      WHEN 'date-time' THEN 'sv.datetime_value'
      ELSE 'sv.text_value' END;
    order_text := sort_direction;
  END IF;

  filter_set := record_query_filters(p_payload->'filters');
  IF filter_set IS NULL THEN RETURN record_error(400, 'invalid_query'); END IF;
  predicate := record_query_predicate(filter_set, types, sensitive, management);
  IF predicate ? 'error' THEN RETURN predicate; END IF;
  predicate_sql := predicate->>'sql';

  cursor_text := nullif(p_payload->>'cursorId', '');
  IF cursor_text IS NOT NULL THEN
    IF cursor_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN record_error(400, 'invalid_cursor'); END IF;
    SELECT c.* INTO cursor_row FROM app_private.record_query_cursors c
      WHERE c.tenant_id = tenant AND c.cursor_id = cursor_text::uuid AND c.caller_scope = caller
        AND c.owner_app_id = owner AND c.collection = collection AND c.filters = filter_set
        AND c.sort = sort_text AND c.schema_revision = revision AND c.expires_at > clock_timestamp();
    IF NOT FOUND THEN RETURN record_error(400, 'invalid_cursor'); END IF;
    comparison := CASE order_text WHEN 'asc' THEN '>' ELSE '<' END;
    IF sort_payload IS NULL OR sort_payload = 'null'::jsonb THEN
      cursor_value := cursor_row.sort_key->>0;
      cursor_sql := format(' AND (r.created_at, r.id) %s (%L::timestamptz, %L::uuid)', comparison, cursor_value, cursor_row.record_id);
    ELSIF jsonb_typeof(cursor_row.sort_key->0) = 'null' THEN
      cursor_sql := format(' AND (%s IS NULL AND r.id %s %L::uuid)', sort_expression, comparison, cursor_row.record_id);
    ELSE
      cursor_value := cursor_row.sort_key->>0;
      cursor_value := CASE sort_kind
        WHEN 'number' THEN format('(%L)::numeric', cursor_value)
        WHEN 'integer' THEN format('(%L)::numeric', cursor_value)
        WHEN 'boolean' THEN format('(%L)::boolean', cursor_value)
        WHEN 'date' THEN format('(%L)::timestamptz', cursor_value)
        WHEN 'date-time' THEN format('(%L)::timestamptz', cursor_value)
        ELSE format('%L', cursor_value) END;
      cursor_sql := format(' AND (%s IS NULL OR %s %s %s OR (%s = %s AND r.id %s %L::uuid))',
        sort_expression, sort_expression, comparison, cursor_value, sort_expression, cursor_value, comparison, cursor_row.record_id);
    END IF;
  END IF;

  from_sql := 'FROM core.app_records r CROSS JOIN LATERAL (SELECT app_private.record_read_scope(r.owner_app_id, r.id) AS scope) perm ' || sort_join;
  where_sql := format('WHERE r.tenant_id = %L AND r.owner_app_id = %L AND r.collection = %L AND perm.scope IS NOT NULL AND (%s)',
    tenant, owner, collection, predicate_sql);
  IF sort_payload IS NULL OR sort_payload = 'null'::jsonb THEN
    order_sql := format('ORDER BY r.created_at %s, r.id %s', order_text, order_text);
  ELSE
    order_sql := format('ORDER BY (%s IS NULL) ASC, %s %s NULLS LAST, r.id %s', sort_expression, sort_expression, order_text, order_text);
  END IF;
  query := format('SELECT r.id, r.collection, r.created_at, r.version, r.data, perm.scope, to_jsonb(%s) AS sort_value %s %s%s %s LIMIT %s',
    sort_expression, from_sql, where_sql, cursor_sql, order_sql, page_limit + 1);

  FOR record_row IN EXECUTE query LOOP
    IF item_count = page_limit THEN
      has_more := true;
      EXIT;
    END IF;
    item_count := item_count + 1;
    data_out := CASE WHEN record_row.scope = 'management' THEN record_row.data - sensitive ELSE record_row.data END;
    items := items || jsonb_build_array(jsonb_build_object(
      'id', record_row.id, 'collection', record_row.collection, 'created_at', record_row.created_at,
      'version', record_row.version, 'data', data_out));
    last_key := jsonb_build_array(record_row.sort_value);
    last_id := record_row.id;
  END LOOP;

  IF has_more THEN
    state := jsonb_build_object('ownerAppId', owner, 'collection', collection, 'filters', filter_set,
      'sort', sort_text, 'schemaRevision', revision, 'sortKey', last_key, 'recordId', last_id);
  END IF;
  RETURN jsonb_build_object('status', 200, 'value', jsonb_build_object(
    'items', items, 'nextCursorId', NULL, 'schemaRevision', revision)) ||
    CASE WHEN state IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('cursor', state) END;
END $$;

CREATE FUNCTION app_private.record_query_list(p_actor uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, app_private, pg_temp SET timezone = 'UTC' AS $$
DECLARE
  tenant text := record_tenant();
  caller bytea := record_caller_scope(p_actor);
  read jsonb;
  state jsonb;
  next_cursor uuid;
BEGIN
  read := record_query_list_read(p_actor, p_payload);
  IF read ? 'error' THEN RETURN read; END IF;
  state := read->'cursor';
  IF state IS NULL OR state = 'null'::jsonb THEN RETURN read - 'cursor'; END IF;
  DELETE FROM app_private.record_query_cursors WHERE (tenant_id, cursor_id) IN (
    SELECT tenant_id, cursor_id FROM app_private.record_query_cursors
      WHERE tenant_id = tenant AND expires_at <= clock_timestamp()
      ORDER BY expires_at LIMIT 32 FOR UPDATE SKIP LOCKED);
  INSERT INTO app_private.record_query_cursors
    (tenant_id, caller_scope, owner_app_id, collection, filters, sort, schema_revision, sort_key, record_id, expires_at)
    VALUES (tenant, caller, (state->>'ownerAppId')::uuid, state->>'collection', state->'filters',
      state->>'sort', (state->>'schemaRevision')::bigint, state->'sortKey', (state->>'recordId')::uuid,
      clock_timestamp() + interval '1 hour')
    RETURNING cursor_id INTO next_cursor;
  RETURN jsonb_set(read - 'cursor', '{value,nextCursorId}', to_jsonb(next_cursor));
END $$;

CREATE FUNCTION app_private.record_query_aggregate(p_actor uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, app_private, pg_temp SET timezone = 'UTC' AS $$
#variable_conflict use_variable
DECLARE
  tenant text := record_tenant();
  owner uuid;
  collection text;
  meta jsonb;
  types jsonb;
  sensitive text[];
  management boolean;
  filter_set jsonb;
  predicate jsonb;
  predicate_sql text;
  group_payload jsonb;
  dimension jsonb;
  field text;
  is_day boolean;
  seen text[] := '{}';
  dimension_sql text;
  joins text := '';
  keys text[] := '{}';
  size integer;
  from_sql text;
  where_sql text;
  query text;
  total bigint;
  groups jsonb;
BEGIN
  owner := nullif(p_payload->>'ownerAppId', '')::uuid;
  owner := coalesce(owner, p_actor);
  collection := p_payload->>'collection';
  IF collection IS NULL OR collection !~ '^[a-z][a-z0-9_-]{0,62}$' THEN RETURN record_error(400, 'invalid_query'); END IF;
  meta := record_query_metadata(owner, collection, p_actor);
  IF meta ? 'error' THEN RETURN meta; END IF;
  types := meta->'value'->'types';
  sensitive := ARRAY(SELECT jsonb_array_elements_text(meta->'value'->'sensitive'));
  management := (meta->'value'->>'management')::boolean;

  filter_set := record_query_filters(p_payload->'filters');
  IF filter_set IS NULL THEN RETURN record_error(400, 'invalid_query'); END IF;
  predicate := record_query_predicate(filter_set, types, sensitive, management);
  IF predicate ? 'error' THEN RETURN predicate; END IF;
  predicate_sql := predicate->>'sql';

  group_payload := coalesce(p_payload->'groupBy', '[]'::jsonb);
  IF jsonb_typeof(group_payload) <> 'array' THEN RETURN record_error(400, 'invalid_query'); END IF;
  IF jsonb_array_length(group_payload) > 2 THEN RETURN record_error(400, 'invalid_query'); END IF;
  size := jsonb_array_length(group_payload);
  FOR dimension IN SELECT value FROM jsonb_array_elements(group_payload) LOOP
    IF jsonb_typeof(dimension) <> 'object' THEN RETURN record_error(400, 'invalid_query'); END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(dimension)) <> 2 OR
        NOT (dimension ? 'field') OR NOT (dimension ? 'day') THEN RETURN record_error(400, 'invalid_query'); END IF;
    field := dimension->>'field';
    is_day := coalesce((dimension->>'day')::boolean, false);
    IF field IS NULL OR field !~ '^[A-Za-z_][A-Za-z0-9_]{0,63}$' OR NOT (types ? field) THEN RETURN record_error(400, 'invalid_query'); END IF;
    IF management AND field = ANY(sensitive) THEN RETURN record_error(400, 'invalid_query'); END IF;
    IF is_day AND types->>field NOT IN ('date', 'date-time') THEN RETURN record_error(400, 'invalid_query'); END IF;
    dimension_sql := field || CASE WHEN is_day THEN ':day' ELSE '' END;
    IF dimension_sql = ANY(seen) THEN RETURN record_error(400, 'invalid_query'); END IF;
    seen := array_append(seen, dimension_sql);
    IF array_length(keys, 1) IS NULL THEN size := 1; ELSE size := array_length(keys, 1) + 1; END IF;
    joins := joins || format(' LEFT JOIN LATERAL (SELECT f.value, f.datetime_value FROM app_private.record_field_values f WHERE f.tenant_id = r.tenant_id AND f.owner_app_id = r.owner_app_id AND f.collection = r.collection AND f.record_id = r.id AND f.field = %L) g%s ON TRUE', field, size);
    IF is_day THEN
      keys := array_append(keys, 'coalesce(to_jsonb(to_char(g' || size || '.datetime_value AT TIME ZONE ''UTC'', ''YYYY-MM-DD'')), ''null''::jsonb)');
    ELSE
      keys := array_append(keys, 'coalesce(g' || size || '.value, ''null''::jsonb)');
    END IF;
  END LOOP;
  IF array_length(keys, 1) IS NULL THEN size := 0; ELSE size := array_length(keys, 1); END IF;

  from_sql := 'FROM core.app_records r CROSS JOIN LATERAL (SELECT app_private.record_read_scope(r.owner_app_id, r.id) AS scope) perm' || joins;
  where_sql := format('WHERE r.tenant_id = %L AND r.owner_app_id = %L AND r.collection = %L AND perm.scope IS NOT NULL AND (%s)',
    tenant, owner, collection, predicate_sql);
  IF size = 0 THEN
    query := format('SELECT count(*)::bigint, ''[]''::jsonb %s %s', from_sql, where_sql);
  ELSE
    query := format('WITH base AS (SELECT r.id, %s AS key %s %s) SELECT (SELECT count(*) FROM base)::bigint, coalesce((SELECT jsonb_agg(jsonb_build_object(''key'', key, ''count'', n) ORDER BY key) FROM (SELECT key, count(*)::bigint AS n FROM base GROUP BY key ORDER BY key LIMIT 1001) grouped), ''[]''::jsonb)',
      'jsonb_build_array(' || array_to_string(keys, ', ') || ')', from_sql, where_sql);
  END IF;
  EXECUTE query INTO total, groups;
  IF jsonb_array_length(groups) > 1000 THEN RETURN record_error(400, 'invalid_query'); END IF;
  RETURN jsonb_build_object('status', 200, 'value', jsonb_build_object('count', total, 'groups', groups));
END $$;

CREATE FUNCTION core.record_query(operation text, payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app_private, pg_temp
SET lock_timeout = '2s' SET timezone = 'UTC' AS $$
DECLARE
  claims jsonb := current_setting('request.jwt.claims', true)::jsonb;
  actor uuid;
  owner_text text;
  owner uuid;
BEGIN
  IF nullif(claims->>'client_id', '') IS NULL OR nullif(claims->>'sub', '') IS NULL
    OR nullif(claims->>'iss', '') IS NULL OR nullif(record_tenant(), '') IS NULL THEN
    RETURN record_error(403, 'verified_client_required');
  END IF;
  actor := record_actor(false);
  owner_text := nullif(payload->>'ownerAppId', '');
  IF owner_text IS NOT NULL AND owner_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN record_error(400, 'invalid_query');
  END IF;
  owner := coalesce(owner_text::uuid, actor);
  IF operation = 'describe' THEN RETURN record_query_metadata(owner, payload->>'collection', actor); END IF;
  IF operation = 'list' THEN RETURN record_query_list(actor, payload); END IF;
  IF operation = 'aggregate' THEN RETURN record_query_aggregate(actor, payload); END IF;
  RETURN record_error(400, 'invalid_request');
END $$;

REVOKE ALL ON FUNCTION app_private.record_query_filters(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.record_query_term(text, text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.record_query_predicate(jsonb, jsonb, text[], boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.record_query_metadata(uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.record_query_list_read(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.record_query_list(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.record_query_aggregate(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION core.record_query(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.record_query(text, jsonb) TO junctura_record_api;
RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (31);
NOTIFY pgrst, 'reload schema';
COMMIT;
