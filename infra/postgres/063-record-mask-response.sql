-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
SET LOCAL ROLE junctura_app_owner;

CREATE OR REPLACE FUNCTION app_private.record_mask_response(p_owner uuid, p_result jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, app_private, pg_temp AS $$
DECLARE
  value jsonb := p_result->'value';
  response_id uuid := (value->>'id')::uuid;
  collection_name text := value->>'collection';
  creator text;
BEGIN
  IF NOT coalesce(value ? 'data', false) THEN RETURN p_result; END IF;
  SELECT r.consent_subject INTO creator FROM core.app_records r
    WHERE (r.tenant_id, r.owner_app_id, r.collection, r.id) = (record_tenant(), p_owner, collection_name, response_id)
      AND split_part(p_result->'headers'->>'ETag', '-', 2) =
          split_part(record_etag(r.tenant_id, p_owner, collection_name, response_id, r.incarnation, r.version), '-', 2);
  RETURN jsonb_set(p_result, '{value,data}', record_mask_data(p_owner, collection_name, response_id, creator, value->'data', 'owner'));
END $$;

RESET ROLE;
INSERT INTO core.schema_migrations(version) VALUES (63);
NOTIFY pgrst, 'reload schema';
COMMIT;
