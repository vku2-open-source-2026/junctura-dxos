-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
SET LOCAL ROLE junctura_app_owner;

CREATE FUNCTION app_private.record_created_period(p_payload jsonb) RETURNS text
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,app_private,pg_temp SET timezone='UTC' AS $$
DECLARE
  start_at timestamptz := record_time('date-time',p_payload->>'createdFrom');
  end_at timestamptz := record_time('date-time',p_payload->>'createdTo');
BEGIN
  IF (p_payload ? 'createdFrom' AND start_at IS NULL) OR
     (p_payload ? 'createdTo' AND end_at IS NULL) OR start_at>=end_at THEN
    RETURN NULL;
  END IF;
  RETURN (CASE WHEN start_at IS NULL THEN '' ELSE format(' AND r.created_at >= %L::timestamptz',start_at) END)
      || (CASE WHEN end_at IS NULL THEN '' ELSE format(' AND r.created_at < %L::timestamptz',end_at) END);
END $$;
REVOKE ALL ON FUNCTION app_private.record_created_period(jsonb) FROM PUBLIC;

DO $$
DECLARE
  definition text := pg_get_functiondef('app_private.record_query_list_read(uuid,jsonb)'::regprocedure);
  declaration text := '  predicate_sql text;';
  anchor text := '  predicate_sql := predicate->>''sql'';';
  condition text := 'tenant, owner, collection, predicate_sql);';
BEGIN
  IF strpos(definition,declaration)=0 OR strpos(definition,anchor)=0 OR strpos(definition,condition)=0 THEN
    RAISE EXCEPTION 'record query list structure changed';
  END IF;
  definition := replace(definition,declaration,declaration || E'\n  created_period_sql text;');
  definition := replace(definition,anchor,anchor || $filters$
  created_period_sql := record_created_period(p_payload);
  IF created_period_sql IS NULL THEN RETURN record_error(400,'invalid_query'); END IF;
  IF created_period_sql<>'' THEN
    filter_set := filter_set || jsonb_build_array(jsonb_build_object(
      'createdFrom',p_payload->>'createdFrom','createdTo',p_payload->>'createdTo'));
  END IF;$filters$);
  EXECUTE replace(definition,condition,condition || E'\n  where_sql := where_sql || created_period_sql;');
END $$;

CREATE OR REPLACE FUNCTION app_private.record_query_aggregate(p_actor uuid, p_payload jsonb) RETURNS jsonb
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
  measure text := coalesce(p_payload->>'measure','count');
  aggregate_field text := p_payload->>'field';
  numeric_expression text := 'NULL::numeric';
  aggregate_expression text := 'NULL::numeric';
  period_sql text;
  result numeric;
  source jsonb;
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

  IF measure NOT IN ('count','sum','avg') OR (measure='count' AND aggregate_field IS NOT NULL) OR
      (measure<>'count' AND (aggregate_field IS NULL OR
        coalesce(types->>aggregate_field,'') NOT IN ('number','integer') OR
        (management AND aggregate_field=ANY(sensitive)))) THEN
    RETURN record_error(400,'invalid_query');
  END IF;
  IF measure<>'count' THEN
    joins := format(' LEFT JOIN app_private.record_field_values m ON
      (m.tenant_id,m.owner_app_id,m.collection,m.record_id)=(r.tenant_id,r.owner_app_id,r.collection,r.id)
      AND m.field=%L',aggregate_field);
    numeric_expression := 'm.number_value';
    aggregate_expression := CASE measure WHEN 'sum' THEN 'sum(amount)' ELSE 'avg(amount)' END;
  END IF;
  period_sql := record_created_period(p_payload);
  IF period_sql IS NULL THEN RETURN record_error(400,'invalid_query'); END IF;

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
  where_sql := where_sql || period_sql;
  IF size = 0 THEN
    query := format('SELECT count(*)::bigint, ''[]''::jsonb, %1$s
        FROM (SELECT %2$s AS amount %3$s %4$s) base',
      aggregate_expression,numeric_expression,from_sql,where_sql);
  ELSE
    query := format('WITH base AS (SELECT %1$s AS key, %2$s AS amount %3$s %4$s),
        grouped AS (SELECT key, count(*)::bigint AS n, %5$s AS value
          FROM base GROUP BY key ORDER BY key LIMIT 1001)
      SELECT count(*)::bigint, coalesce((SELECT jsonb_agg(
        jsonb_build_object(''key'',key,''count'',n) ||
          CASE WHEN %6$L <> ''count'' THEN jsonb_build_object(''value'',value) ELSE ''{}''::jsonb END
        ORDER BY key) FROM grouped),''[]''::jsonb), %5$s FROM base',
      'jsonb_build_array(' || array_to_string(keys, ', ') || ')',numeric_expression,from_sql,
      where_sql,aggregate_expression,measure);
  END IF;
  EXECUTE query INTO total, groups, result;
  IF jsonb_array_length(groups) > 1000 THEN RETURN record_error(400, 'invalid_query'); END IF;
  source := jsonb_build_object('collection',collection,'ownerAppId',owner,'measure',measure,
    'field',aggregate_field,'filters',filter_set,'groupBy',group_payload,
    'createdFrom',p_payload->>'createdFrom','createdTo',p_payload->>'createdTo');
  RETURN jsonb_build_object('status',200,'value',jsonb_build_object('count',total,'groups',groups,'source',source)
    || CASE WHEN measure<>'count' THEN jsonb_build_object('value',result) ELSE '{}'::jsonb END);
END $$;

RESET ROLE;
INSERT INTO core.schema_migrations(version) VALUES (70);
NOTIFY pgrst,'reload schema';
COMMIT;
