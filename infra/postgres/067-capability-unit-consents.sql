-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

ALTER TABLE execution_private.subject_consents
  ALTER COLUMN consumer_app_id DROP NOT NULL,
  ADD COLUMN recipient_unit text CHECK (recipient_unit ~ '^[a-z][a-z0-9-]{1,63}$'),
  ADD CONSTRAINT subject_consent_recipient_check CHECK (
    (consumer_app_id IS NOT NULL AND recipient_unit IS NULL)
    OR (consumer_app_id IS NULL AND recipient_unit IS NOT NULL AND canonical_subject IS NOT NULL));

CREATE INDEX subject_consent_unit_idx ON execution_private.subject_consents
  (tenant_id,recipient_unit,issuer,canonical_subject,capability_id)
  WHERE recipient_unit IS NOT NULL AND revoked_at IS NULL;

CREATE OR REPLACE FUNCTION app_private.retire_unit_consents() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,app_private,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.pending_delete AND NOT OLD.pending_delete) THEN
    UPDATE resource_consents SET unit_retired_at=clock_timestamp()
      WHERE tenant_id=OLD.tenant_id AND recipient_unit=OLD.unit AND unit_retired_at IS NULL;
    UPDATE execution_private.subject_consents SET revoked_at=clock_timestamp()
      WHERE tenant_id=OLD.tenant_id AND recipient_unit=OLD.unit AND revoked_at IS NULL;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION execution_private.consent_view(s execution_private.subject_consents) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('consentId',s.consent_id,'capabilityId',s.capability_id,
    'capabilityTitle',(SELECT v.manifest->>'title' FROM app_private.capability_versions v WHERE v.tenant_id=s.tenant_id
       AND v.capability_id=s.capability_id ORDER BY v.created_at DESC LIMIT 1),
    'purposes',to_jsonb(s.purposes),
    'createdAt',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt',to_char(s.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'revokedAt',CASE WHEN s.revoked_at IS NULL THEN NULL ELSE to_char(s.revoked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'state',CASE WHEN s.revoked_at IS NOT NULL THEN 'revoked' WHEN s.expires_at<=clock_timestamp() THEN 'expired' ELSE 'active' END)
    || CASE WHEN s.recipient_unit IS NOT NULL THEN jsonb_build_object('recipientUnit',s.recipient_unit)
       ELSE jsonb_build_object('consumer',jsonb_build_object('appId',s.consumer_app_id,'displayName',
         (SELECT a.display_name FROM app_private.applications a WHERE a.tenant_id=s.tenant_id AND a.app_id=s.consumer_app_id))) END
$$;

DO $migration$
DECLARE source text; updated text;
BEGIN
  source:=pg_get_functiondef('core.subject_consent(text,jsonb)'::regprocedure);
  updated:=replace(source,
    $old$IF (payload - 'consent' - 'key' - 'digest') <> '{}'::jsonb
       OR coalesce(consent->>'consumerAppId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'$old$,
    $new$IF consent-ARRAY['consumerAppId','recipientUnit','capabilityId','purposes','expiresAt']<>'{}'::jsonb
       OR (consent ? 'consumerAppId')=(consent ? 'recipientUnit')
       OR (consent ? 'consumerAppId' AND coalesce(consent->>'consumerAppId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
       OR (consent ? 'recipientUnit' AND coalesce(consent->>'recipientUnit','') !~ '^[a-z][a-z0-9-]{1,63}$')$new$);
  IF updated=source THEN RAISE EXCEPTION 'Unexpected capability consent validation'; END IF;
  source:=updated;
  updated:=replace(source,
    $old$IF NOT EXISTS (SELECT FROM app_private.applications a WHERE a.tenant_id=tenant AND a.issuer=iss
                     AND a.app_id=(consent->>'consumerAppId')::uuid AND a.state='active')
       OR NOT EXISTS$old$,
    $new$IF consent ? 'recipientUnit' THEN
      IF bound IS NULL OR sid IS DISTINCT FROM bound THEN
        RETURN jsonb_build_object('status',403,'error','verified_subject_required');
      END IF;
      -- Keep the unit live until the grant is stored, or observe its retirement.
      PERFORM 1 FROM app_private.directory_units u WHERE u.tenant_id=tenant AND u.unit=consent->>'recipientUnit'
        AND NOT u.pending_delete AND u.confirmed_value IS NOT NULL FOR SHARE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',404,'error','not_found'); END IF;
    ELSIF NOT EXISTS (SELECT FROM app_private.applications a WHERE a.tenant_id=tenant AND a.issuer=iss
                     AND a.app_id=(consent->>'consumerAppId')::uuid AND a.state='active') THEN
      RETURN jsonb_build_object('status',404,'error','not_found');
    END IF;
    IF NOT EXISTS$new$);
  IF updated=source THEN RAISE EXCEPTION 'Unexpected capability consent recipient checks'; END IF;
  source:=updated;
  updated:=replace(source,
    $old$consumer_app_id, capability_id, purposes, expires_at)
      VALUES (tenant, iss, who, bound, (consent->>'consumerAppId')::uuid, consent->>'capabilityId', purposes, expiry)$old$,
    $new$consumer_app_id, recipient_unit, capability_id, purposes, expires_at)
      VALUES (tenant, iss, who, bound, (consent->>'consumerAppId')::uuid, consent->>'recipientUnit', consent->>'capabilityId', purposes, expiry)$new$);
  IF updated=source THEN RAISE EXCEPTION 'Unexpected capability consent insert'; END IF;
  EXECUTE updated;
END $migration$;

RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES(67);
NOTIFY pgrst,'reload schema';
COMMIT;
