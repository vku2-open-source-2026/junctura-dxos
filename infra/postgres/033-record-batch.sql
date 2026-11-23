-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
SET LOCAL ROLE junctura_app_owner;
SET LOCAL search_path = pg_catalog, app_private;

CREATE FUNCTION app_private.record_upsert(p_actor uuid, p_collection text, p_key text, p_data jsonb,
    p_if_match text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, app_private AS $$
DECLARE
  m app_private.record_collections := record_lock_collection(p_actor, p_collection);
  target_id uuid;
BEGIN
  IF m.unique_key_field IS NULL OR p_key IS NULL OR p_key COLLATE "C" !~ '^[A-Za-z0-9_-]{1,128}$'
    OR jsonb_typeof(p_data->m.unique_key_field) IS DISTINCT FROM 'string'
    OR (p_data->>m.unique_key_field) COLLATE "C" IS DISTINCT FROM p_key THEN
    RETURN record_error(400, 'invalid_request');
  END IF;
  SELECT id INTO target_id FROM core.app_records WHERE tenant_id = m.tenant_id AND owner_app_id = p_actor
    AND collection = p_collection AND unique_key_value = p_key;
  IF target_id IS NULL THEN
    IF p_if_match IS NOT NULL THEN RETURN record_error(412, 'precondition_failed'); END IF;
    RETURN record_write('create', p_actor, p_collection, NULL, p_data, NULL, false);
  END IF;
  RETURN record_write('replace', p_actor, p_collection, target_id, p_data, p_if_match, true);
END $$;

CREATE FUNCTION app_private.record_batch_issues(p_base text, p_issues jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, app_private AS $$
  SELECT jsonb_agg(jsonb_set(issue, '{path}', to_jsonb(p_base || (issue->>'path'))) ORDER BY issue_ordinality)
  FROM jsonb_array_elements(p_issues) WITH ORDINALITY AS issues(issue, issue_ordinality)
$$;

CREATE FUNCTION app_private.record_batch(p_actor uuid, p_operations jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, app_private AS $$
DECLARE
  name text;
  item jsonb;
  item_number bigint;
  kind text;
  result jsonb;
  entries jsonb := '[]';
  pointer text;
BEGIN
  IF jsonb_typeof(p_operations) IS DISTINCT FROM 'array' THEN RETURN record_error(400, 'invalid_request'); END IF;
  IF jsonb_array_length(p_operations) NOT BETWEEN 1 AND 50 THEN RETURN record_error(400, 'invalid_request'); END IF;

  FOR name IN SELECT DISTINCT (value->>'collection') COLLATE "C" AS collection
    FROM jsonb_array_elements(p_operations) ORDER BY collection
  LOOP
    PERFORM record_lock_collection(p_actor, name);
  END LOOP;

  FOR item, item_number IN SELECT value, ordinality FROM jsonb_array_elements(p_operations) WITH ORDINALITY LOOP
    kind := item->>'op';
    result := record_write(kind, p_actor, item->>'collection', (item->>'id')::uuid,
      CASE WHEN kind = 'increment' THEN item->'operations' ELSE item->'data' END,
      item->>'ifMatch', kind IN ('replace','delete'));
    IF result ? 'error' THEN
      pointer := '/operations/' || (item_number - 1);
      IF result->>'error' = 'schema_violation' THEN
        result := jsonb_set(result, '{details,issues}', record_batch_issues(pointer, result->'details'->'issues'));
      ELSIF result->>'error' = 'invalid_request' THEN
        result := record_error(400, 'invalid_request', jsonb_build_object('issues', record_issue(pointer, 'properties')));
      END IF;
      RAISE SQLSTATE 'PBR01';
    END IF;
    entries := entries || jsonb_build_array(jsonb_build_object('op', kind,
      'id', coalesce(result->'value'->'id', item->'id'), 'version', result->'value'->'version'));
  END LOOP;
  RETURN jsonb_build_object('status', 200, 'value', jsonb_build_object('results', entries));
EXCEPTION WHEN SQLSTATE 'PBR01' THEN
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION app_private.record_apply(p_operation text, p_actor uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, app_private AS $$
BEGIN
  CASE p_operation
    WHEN 'upsert' THEN RETURN record_upsert(p_actor, p_payload->>'collection', p_payload->>'uniqueValue',
      p_payload->'body'->'data', p_payload->>'ifMatch');
    WHEN 'batch' THEN RETURN record_batch(p_actor, p_payload->'body'->'operations');
    ELSE RETURN record_apply_single(p_operation, p_actor, p_payload);
  END CASE;
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private FROM PUBLIC;
RESET ROLE;
INSERT INTO core.schema_migrations(version) VALUES (33);
NOTIFY pgrst, 'reload schema';
COMMIT;
