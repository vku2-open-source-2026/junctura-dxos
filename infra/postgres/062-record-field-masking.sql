-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
REVOKE SELECT ON core.app_records FROM junctura_resource_api;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

ALTER TABLE app_private.record_collections ADD COLUMN field_masking jsonb NOT NULL DEFAULT '{}'
  CHECK (jsonb_typeof(field_masking) = 'object' AND NOT (field_masking ? unique_key_field));
ALTER TABLE app_private.record_export_lines ADD COLUMN consent_subject text;

CREATE FUNCTION app_private.record_mask_policy(p_actor uuid, p_collection text, p_fields jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, app_private, pg_temp AS $$
DECLARE
  tenant text := record_tenant();
  metadata record_collections;
BEGIN
  IF p_actor IS NULL THEN RETURN record_error(403, 'application_access_required'); END IF;
  IF p_collection IS NULL OR p_collection !~ '^[a-z][a-z0-9_-]{0,62}$' THEN
    RETURN record_error(400, 'invalid_request');
  END IF;
  IF p_fields IS NULL THEN
    SELECT field_masking INTO p_fields FROM record_collections
      WHERE tenant_id = tenant AND owner_app_id = p_actor AND collection = p_collection;
  ELSE
    IF jsonb_typeof(p_fields) <> 'object' THEN RETURN record_error(400, 'invalid_request'); END IF;
    metadata := record_lock_collection(p_actor, p_collection);
    IF p_fields ? metadata.unique_key_field THEN RETURN record_error(409, 'resource_conflict'); END IF;
    IF EXISTS (
      SELECT FROM jsonb_each(p_fields) AS rule(field, settings)
      CROSS JOIN LATERAL jsonb_array_elements_text(rule.settings->'shareIds') AS requested(share_id)
      WHERE NOT EXISTS (
        SELECT FROM resource_shares s JOIN core.app_records r
          ON (r.tenant_id, r.owner_app_id, r.id) = (s.tenant_id, s.owner_app_id, s.resource_id)
        WHERE (s.tenant_id, s.owner_app_id, s.share_id) = (tenant, p_actor, requested.share_id::uuid)
          AND s.resource_type = 'record' AND r.collection = p_collection AND s.grantee_app_id IS NOT NULL)
    ) THEN RETURN record_error(400, 'invalid_request'); END IF;
    UPDATE record_collections SET field_masking = p_fields, schema_revision = schema_revision + 1
      WHERE (tenant_id, owner_app_id, collection) = (tenant, p_actor, p_collection)
        AND field_masking IS DISTINCT FROM p_fields;
  END IF;
  RETURN jsonb_build_object('status', 200, 'value', jsonb_build_object(
    'collection', p_collection, 'fields', coalesce(p_fields, '{}'::jsonb)));
END $$;

CREATE FUNCTION app_private.record_mask_data(p_owner uuid, p_collection text, p_id uuid,
    p_subject text, p_data jsonb, p_scope text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, app_private, pg_temp AS $$
DECLARE
  tenant text := record_tenant();
  claims jsonb := current_setting('request.jwt.claims', true)::jsonb;
  policy jsonb;
  sensitive text[];
  actor uuid;
  roles jsonb;
  is_owner boolean;
  rule record;
  revealed boolean := false;
  replacement text;
BEGIN
  SELECT field_masking, sensitive_fields INTO policy, sensitive FROM record_collections
    WHERE (tenant_id, owner_app_id, collection) = (tenant, p_owner, p_collection);
  IF p_scope = 'management' THEN
    p_data := p_data - ARRAY(SELECT name FROM unnest(sensitive) AS name WHERE NOT (policy ? name));
  END IF;
  IF policy IS NULL OR policy = '{}'::jsonb THEN RETURN p_data; END IF;

  actor := core.resource_actor();
  roles := coalesce(claims->'record_roles', '[]'::jsonb);
  IF actor = p_owner THEN roles := roles || coalesce(claims->'app_roles', '[]'::jsonb); END IF;
  is_owner := actor = p_owner AND CASE WHEN claims ? 'human_app_id' THEN p_subject = claims->>'sub' ELSE true END;

  FOR rule IN SELECT key AS field, value AS settings FROM jsonb_each(policy) WHERE p_data ? key LOOP
    IF (is_owner AND rule.settings->'owner' = 'true'::jsonb)
      OR EXISTS (SELECT FROM jsonb_array_elements_text(rule.settings->'roles') AS allowed(role)
                 WHERE roles ? allowed.role)
      OR EXISTS (
        SELECT FROM jsonb_array_elements_text(rule.settings->'shareIds') AS allowed(share_id)
        JOIN resource_shares s ON s.share_id = allowed.share_id::uuid
        WHERE (s.tenant_id, s.owner_app_id, s.resource_id, s.grantee_app_id) = (tenant, p_owner, p_id, actor)
          AND s.resource_type = 'record' AND s.action = 'read' AND NOT s.revoked AND s.expires_at > now()
      ) THEN
      revealed := true;
    ELSE
      replacement := '***';
      IF rule.settings->>'mask' = 'last4' AND jsonb_typeof(p_data->rule.field) = 'string'
        AND char_length(p_data->>rule.field) > 4 THEN
        replacement := replacement || right(p_data->>rule.field, 4);
      END IF;
      p_data := jsonb_set(p_data, ARRAY[rule.field], to_jsonb(replacement));
    END IF;
  END LOOP;
  IF revealed THEN PERFORM audit_append('audit.record_fields_revealed', 'audit', p_id, 0); END IF;
  RETURN p_data;
END $$;

CREATE FUNCTION app_private.record_mask_response(p_owner uuid, p_result jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, app_private, pg_temp AS $$
DECLARE
  value jsonb := p_result->'value';
  id uuid := (value->>'id')::uuid;
  collection_name text := value->>'collection';
  creator text;
BEGIN
  IF NOT coalesce(value ? 'data', false) THEN RETURN p_result; END IF;
  SELECT r.consent_subject INTO creator FROM core.app_records r
    WHERE (r.tenant_id, r.owner_app_id, r.collection, r.id) = (record_tenant(), p_owner, collection_name, id)
      AND split_part(p_result->'headers'->>'ETag', '-', 2) =
          split_part(record_etag(r.tenant_id, p_owner, collection_name, id, r.incarnation, r.version), '-', 2);
  RETURN jsonb_set(p_result, '{value,data}', record_mask_data(p_owner, collection_name, id, creator, value->'data', 'owner'));
END $$;

CREATE FUNCTION app_private.record_legacy_list(p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, app_private, pg_temp SET timezone = 'UTC' AS $$
DECLARE
  collection_name text := p_payload->>'collection';
  page_limit integer := (p_payload->>'limit')::integer;
  direction text := p_payload->>'order';
  boundary_time timestamptz := (p_payload->'cursor'->>'t')::timestamptz;
  boundary_id uuid := (p_payload->'cursor'->>'i')::uuid;
  r core.app_records;
  items jsonb := '[]';
  has_more boolean := false;
BEGIN
  IF core.resource_actor() IS NULL THEN RETURN record_error(403, 'application_access_required'); END IF;
  IF collection_name IS NULL OR collection_name !~ '^[a-z][a-z0-9_-]{0,62}$'
    OR page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 100
    OR direction IS NULL OR direction NOT IN ('asc', 'desc') THEN RETURN record_error(400, 'invalid_query'); END IF;

  FOR r IN EXECUTE format(
    'SELECT r.* FROM core.app_records r WHERE r.tenant_id = $1 AND r.collection = $2
      AND core.resource_readable(r.owner_app_id, ''record'', r.id)
      AND ($3 IS NULL OR (r.created_at, r.id) %s ($3, $4))
      ORDER BY r.created_at %s, r.id %s LIMIT $5',
    CASE direction WHEN 'asc' THEN '>' ELSE '<' END, direction, direction)
    USING record_tenant(), collection_name, boundary_time, boundary_id, page_limit + 1
  LOOP
    IF jsonb_array_length(items) = page_limit THEN
      has_more := true;
      EXIT;
    END IF;
    items := items || jsonb_build_array(jsonb_build_object(
      'id', r.id, 'collection', r.collection, 'created_at', r.created_at,
      'data', record_mask_data(r.owner_app_id, r.collection, r.id, r.consent_subject, r.data, 'shared')));
  END LOOP;
  RETURN jsonb_build_object('status', 200, 'value', jsonb_build_object('items', items, 'hasMore', has_more));
END $$;

CREATE OR REPLACE FUNCTION app_private.record_response(p_status integer, p_record core.app_records, p_scope text)
RETURNS jsonb LANGUAGE sql SET search_path = pg_catalog, app_private, pg_temp AS $$
  SELECT jsonb_build_object('status', p_status, 'value', jsonb_build_object('id', p_record.id, 'collection',
    p_record.collection, 'created_at', p_record.created_at, 'version', p_record.version, 'data',
    CASE WHEN p_scope = 'write' THEN p_record.data ELSE record_mask_data(p_record.owner_app_id, p_record.collection,
      p_record.id, p_record.consent_subject, p_record.data, p_scope) END)) ||
    CASE WHEN p_scope IN ('owner', 'write') THEN jsonb_build_object('headers',
      jsonb_build_object('ETag', record_etag(p_record.tenant_id, p_record.owner_app_id, p_record.collection,
        p_record.id, p_record.incarnation, p_record.version))) ELSE '{}'::jsonb END
$$;

-- Keep the existing query, archive and write behavior around the projection changes.
ALTER FUNCTION app_private.record_get(text,uuid) VOLATILE;
ALTER FUNCTION app_private.record_query_list_read(uuid,jsonb) VOLATILE;
DO $migration$
DECLARE
  change record;
  source text;
BEGIN
  FOR change IN SELECT * FROM (VALUES
    ('app_private.record_write(text,uuid,text,uuid,jsonb,text,boolean)', 'r, ''owner'');', 'r, ''write'');'),
    ('app_private.record_register(uuid,text,jsonb)', 'PERFORM record_lock_collection(p_owner_app, p_collection);',
      $new$IF (record_lock_collection(p_owner_app, p_collection)).field_masking ? unique_field THEN
    RETURN record_error(409, 'resource_conflict');
  END IF;$new$),
    ('app_private.record_next_data(core.app_records,app_private.record_collections,text,jsonb)',
      'NOT (field = ANY(p_metadata.indexed_fields)) OR',
      'NOT (field = ANY(p_metadata.indexed_fields)) OR p_metadata.field_masking ? field OR'),
    ('core.record_command(text,jsonb)', '  IF NOT core.resource_writer() THEN',
      $new$  IF operation = 'legacy_list' THEN RETURN record_legacy_list(payload); END IF;
  IF operation = 'get_masking' THEN RETURN record_mask_policy(record_actor(false), payload->>'collection', NULL); END IF;
  IF NOT core.resource_writer() THEN$new$),
    ('core.record_command(text,jsonb)', '  IF payload->>''requestKey'' IS NOT NULL THEN',
      $new$  IF operation = 'put_masking' THEN
    IF claims ? 'human_app_id' AND NOT coalesce(claims->'app_roles' ? 'manager', false) THEN
      RETURN record_error(403, 'write_forbidden');
    END IF;
    IF NOT (payload ? 'fields') THEN RETURN record_error(400, 'invalid_request'); END IF;
    RETURN record_mask_policy(actor, payload->>'collection', payload->'fields');
  END IF;
  IF payload->>'requestKey' IS NOT NULL THEN$new$),
    ('core.record_command(text,jsonb)', 'IF result IS NOT NULL THEN RETURN result; END IF;',
      'IF result IS NOT NULL THEN RETURN record_mask_response(actor, result); END IF;'),
    ('core.record_command(text,jsonb)', E'  RETURN result;\nEND', E'  RETURN record_mask_response(actor, result);\nEND'),
    ('app_private.record_query_metadata(uuid,text,uuid)', 'm.schema_revision, m.indexed_fields, m.sensitive_fields',
      $new$m.schema_revision, ARRAY(SELECT field FROM unnest(m.indexed_fields) AS field WHERE NOT (m.field_masking ? field)), m.sensitive_fields$new$),
    ('app_private.record_query_list_read(uuid,jsonb)', 'r.version, r.data, perm.scope',
      'r.version, r.data, r.consent_subject, perm.scope'),
    ('app_private.record_query_list_read(uuid,jsonb)',
      'CASE WHEN record_row.scope = ''management'' THEN record_row.data - sensitive ELSE record_row.data END',
      $new$record_mask_data(owner, collection, record_row.id, record_row.consent_subject, record_row.data, record_row.scope)$new$),
    ('app_private.record_query_list(uuid,jsonb)', '  read := record_query_list_read(p_actor, p_payload);',
      $new$  PERFORM 1 FROM record_collections m WHERE (m.tenant_id, m.owner_app_id, m.collection) =
    (tenant, coalesce(nullif(p_payload->>'ownerAppId', '')::uuid, p_actor), p_payload->>'collection') FOR SHARE;
  read := record_query_list_read(p_actor, p_payload);$new$),
    ('app_private.record_export_start(uuid,text,bytea)', 'collection, record_id, data)',
      'collection, record_id, data, consent_subject)'),
    ('app_private.record_export_start(uuid,text,bytea)', 'snapshot, r.collection, r.id, r.data',
      'snapshot, r.collection, r.id, r.data, r.consent_subject'),
    ('app_private.record_export_page(uuid,bytea,text,uuid)', 'SELECT s.snapshot_id FROM',
      'SELECT s.snapshot_id, s.owner_app_id FROM'),
    ('app_private.record_export_page(uuid,bytea,text,uuid)', 'SELECT l.collection, l.record_id, l.data',
      'SELECT l.collection, l.record_id, l.data, l.consent_subject, s.owner_app_id'),
    ('app_private.record_export_page(uuid,bytea,text,uuid)', '''id'', record_id, ''data'', data)',
      $new$'id', record_id, 'data', record_mask_data(owner_app_id, collection, record_id, consent_subject, data, 'owner'))$new$),
    ('core.search_command(text,jsonb)', '''searchable'',c.searchable_fields,''sensitive'',c.sensitive_fields,''data'',r.data',
      $new$'searchable',ARRAY(SELECT field FROM unnest(c.searchable_fields) AS field WHERE NOT (c.field_masking ? field)),
          'sensitive',c.sensitive_fields,'data',r.data - ARRAY(SELECT jsonb_object_keys(c.field_masking))$new$)
  ) AS changes(signature, old_text, new_text) LOOP
    source := pg_get_functiondef(change.signature::regprocedure);
    IF strpos(source, change.old_text) = 0 THEN
      RAISE EXCEPTION 'Unexpected definition for %', change.signature;
    END IF;
    EXECUTE replace(source, change.old_text, change.new_text);
  END LOOP;
END $migration$;

REVOKE ALL ON FUNCTION app_private.record_mask_policy(uuid,text,jsonb),
  app_private.record_mask_data(uuid,text,uuid,text,jsonb,text), app_private.record_mask_response(uuid,jsonb),
  app_private.record_legacy_list(jsonb) FROM PUBLIC;
RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (62);
NOTIFY pgrst, 'reload schema';
COMMIT;
