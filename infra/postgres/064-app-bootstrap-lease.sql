-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;
DO $migration$
DECLARE original text; updated text;
BEGIN
  original := pg_get_functiondef('core.application_management(text,jsonb)'::regprocedure);
  updated := replace(original, $old$  IF operation='lease' THEN$old$, $new$  IF operation='lease' THEN
    -- An interrupted provider operation cannot reacquire its expired fence.
    IF payload->>'renew'='true' AND NOT EXISTS (
      SELECT FROM app_sync_leases l WHERE l.tenant_id=tenant AND l.app_id=a.app_id
        AND l.lease_id=(payload->>'lease')::uuid AND l.expires_at>clock_timestamp()
    ) THEN RETURN jsonb_build_object('status',409,'error','resource_conflict'); END IF;$new$);
  IF updated=original THEN RAISE EXCEPTION 'Unexpected application provider lease'; END IF;
  EXECUTE updated;
END $migration$;
RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES(62);
NOTIFY pgrst,'reload schema';
COMMIT;
