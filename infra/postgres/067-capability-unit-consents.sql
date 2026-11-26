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

ALTER TABLE execution_private.executions
  ADD COLUMN recipient_unit text,
  ADD COLUMN initiating_service_subject text,
  ADD CONSTRAINT execution_recipient_unit_check CHECK (
    (recipient_unit IS NULL AND initiating_service_subject IS NULL)
    OR (recipient_unit IS NOT NULL AND recipient_unit ~ '^[a-z][a-z0-9-]{1,63}$' AND initiating_service_subject IS NOT NULL));

-- Existing app grants stay app-bound. Unit consent only applies to a verified
-- caller using its current assignment and a canonical subject binding.
CREATE FUNCTION execution_private.unit_consent(p_tenant text,p_issuer text,p_subject text,p_unit text,
  p_capability text,p_purpose text,p_consent uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE selected execution_private.subject_consents; stamp timestamptz:=clock_timestamp();
BEGIN
  SELECT s.* INTO selected FROM execution_private.subject_consents s
    WHERE s.tenant_id=p_tenant AND s.issuer=p_issuer AND s.canonical_subject=p_subject
      AND s.recipient_unit=p_unit AND s.capability_id=p_capability AND p_purpose=ANY(s.purposes)
      AND (p_consent IS NULL OR s.consent_id=p_consent)
    ORDER BY (s.revoked_at IS NULL AND s.expires_at>stamp) DESC,s.expires_at DESC,s.consent_id
    LIMIT 1 FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','consent_missing'); END IF;
  IF selected.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('error','consent_revoked'); END IF;
  IF selected.expires_at<=stamp THEN RETURN jsonb_build_object('error','consent_expired'); END IF;
  RETURN jsonb_build_object('consentId',selected.consent_id);
END $$;
REVOKE ALL ON FUNCTION execution_private.unit_consent(text,text,text,text,text,text,uuid) FROM PUBLIC;

DO $migration$
DECLARE change record; source text; updated text;
BEGIN
  FOR change IN SELECT * FROM (VALUES
    ('core.record_app_denial(jsonb)',
     $old$'consent_required','consent_revoked','consent_expired','unit_mismatch'$old$,
     $new$'consent_required','consent_missing','consent_revoked','consent_expired','unit_mismatch'$new$),
    -- The approved direct grant still belongs to the same enrolled app. Use
    -- the verified service component of its bearer for that independent check.
    ('trust_private.granted(app_private.capability_versions,text)',
     $old$AND (g.proposal->'subjectIds') ? (current_setting('request.jwt.claims',true)::jsonb->>'sub')$old$,
     $new$AND (g.proposal->'subjectIds') ? (CASE WHEN operation='invoke' AND
        current_setting('request.jwt.claims',true)::jsonb->>'role'='junctura_execution_api' AND
        current_setting('request.jwt.claims',true)::jsonb->>'resource_unit' IS NOT NULL
      THEN current_setting('request.jwt.claims',true)::jsonb->>'actor_sub'
      ELSE current_setting('request.jwt.claims',true)::jsonb->>'sub' END)$new$),
    ('execution_private.execution_command_base(text,jsonb)',
     $old$IF e.request_digest<>payload->>'requestDigest' OR$old$,
     $new$IF e.recipient_unit IS DISTINCT FROM c->>'resource_unit'
        OR e.initiating_service_subject IS DISTINCT FROM c->>'actor_sub'
        OR e.request_digest<>payload->>'requestDigest' OR$new$),
    ('execution_private.execution_command_base(text,jsonb)',
     $old$INSERT INTO execution_private.executions(tenant_id,execution_id,issuer,initiating_subject,initiating_client,$old$,
     $new$INSERT INTO execution_private.executions(tenant_id,execution_id,issuer,initiating_subject,initiating_client,recipient_unit,initiating_service_subject,$new$),
    ('execution_private.execution_command_base(text,jsonb)',
     $old$VALUES(tenant,(payload->>'executionId')::uuid,c->>'iss',c->>'sub',c->>'client_id',actor,$old$,
     $new$VALUES(tenant,(payload->>'executionId')::uuid,c->>'iss',c->>'sub',c->>'client_id',c->>'resource_unit',c->>'actor_sub',actor,$new$),
    ('execution_private.execution_command_base(text,jsonb)',
     $old$'tenantId',e.tenant_id,'issuer',e.issuer,'subject',e.initiating_subject,'clientId',e.initiating_client,
        'target',$old$,
     $new$'tenantId',e.tenant_id,'issuer',e.issuer,'subject',e.initiating_subject,'clientId',e.initiating_client,
        'resourceUnit',e.recipient_unit,'actorSubject',e.initiating_service_subject,
        'humanAppId',CASE WHEN e.recipient_unit IS NOT NULL THEN e.consumer_app_id END,
        'target',$new$),
    ('execution_private.execution_command_base(text,jsonb)',
     $old$'principalType','service','initiatingSubject',e.initiating_subject$old$,
     $new$'principalType',CASE WHEN e.initiating_service_subject IS NULL THEN 'service' ELSE 'user' END,'initiatingSubject',e.initiating_subject$new$),
    ('execution_private.execution_command_base(text,jsonb)',
     $old$e.initiating_client<>c->>'client_id' THEN$old$,
     $new$e.initiating_client<>c->>'client_id'
    OR e.recipient_unit IS DISTINCT FROM c->>'resource_unit'
    OR e.initiating_service_subject IS DISTINCT FROM c->>'actor_sub' THEN$new$),
    ('execution_private.live(execution_private.executions)',
     $old$'sub',e.initiating_subject,'client_id',e.initiating_client,'trust_writer',true,'c4a_grant_id',e.grant_id)::text,true);$old$,
     $new$'sub',e.initiating_subject,'client_id',e.initiating_client,'trust_writer',true,'c4a_grant_id',e.grant_id,
    'role','junctura_execution_api','resource_unit',e.recipient_unit,'actor_sub',e.initiating_service_subject,
    'human_app_id',CASE WHEN e.recipient_unit IS NOT NULL THEN e.consumer_app_id END)::text,true);$new$),
    ('execution_private.lease_valid(execution_private.executions)',
     $old$OR proof->'writer' IS DISTINCT FROM 'true'::jsonb THEN$old$,
     $new$OR proof->>'resourceUnit' IS DISTINCT FROM e.recipient_unit
    OR proof->>'actorSubject' IS DISTINCT FROM e.initiating_service_subject
    OR proof->'writer' IS DISTINCT FROM 'true'::jsonb THEN$new$),
    ('core.execution_command(text,jsonb)',
     $old$request_subject_kind text; failure text;$old$,
     $new$request_subject_kind text; failure text; unit_consent jsonb; unit_key text:=c->>'resource_unit';$new$),
    ('core.execution_command(text,jsonb)',
     $old$IF execution_private.active_consent(tenant, e.issuer, stored.data_subject, stored.subject_kind,$old$,
     $new$IF e.recipient_unit IS NOT NULL THEN
        unit_consent:=execution_private.unit_consent(tenant,e.issuer,stored.data_subject,e.recipient_unit,
          e.capability_id,stored.purpose,stored.consent_id);
        IF unit_consent ? 'error' THEN RETURN jsonb_build_object('status',403,'error',unit_consent->>'error'); END IF;
      ELSIF execution_private.active_consent(tenant, e.issuer, stored.data_subject, stored.subject_kind,$new$),
    ('core.execution_command(text,jsonb)',
     $old$  IF operation IS DISTINCT FROM 'reserve' OR jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN$old$,
     $new$  IF unit_key IS NOT NULL AND operation IN ('get','prepare','dispatch') AND jsonb_typeof(payload)='object' THEN
    result:=execution_private.execution_command_base('get',payload);
    IF result->>'status'<>'200' THEN RETURN result; END IF;
    SELECT x.* INTO stored FROM execution_private.execution_contexts x
      WHERE x.tenant_id=tenant AND x.execution_id=(payload->>'executionId')::uuid;
    IF FOUND AND stored.data_subject IS NOT NULL THEN
      unit_consent:=execution_private.unit_consent(tenant,c->>'iss',stored.data_subject,unit_key,
        (SELECT x.capability_id FROM execution_private.executions x
         WHERE x.tenant_id=tenant AND x.execution_id=stored.execution_id),stored.purpose,stored.consent_id);
      IF unit_consent ? 'error' THEN RETURN jsonb_build_object('status',403,'error',unit_consent->>'error'); END IF;
    END IF;
    IF operation='get' THEN RETURN result; END IF;
  END IF;
  IF operation IS DISTINCT FROM 'reserve' OR jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN$new$),
    ('core.execution_command(text,jsonb)',
     $old$  IF request_subject_kind='canonical' AND NOT EXISTS$old$,
     $new$  IF unit_key IS NOT NULL THEN
    result:=execution_private.resolve_reference(payload->'target');
    IF result->>'status'<>'200' THEN RETURN result; END IF;
    IF ctx ? 'emergency' THEN RETURN jsonb_build_object('status',403,'error','capability_not_granted'); END IF;
    IF ctx ? 'dataSubject' AND request_subject_kind IS DISTINCT FROM 'canonical' THEN
      RETURN jsonb_build_object('status',404,'error','not_found');
    END IF;
  END IF;
  IF request_subject_kind='canonical' AND NOT EXISTS$new$),
    ('core.execution_command(text,jsonb)',
     $old$    RETURN jsonb_build_object('status',403,'error','verified_subject_required');$old$,
     $new$    IF unit_key IS NOT NULL THEN RETURN jsonb_build_object('status',404,'error','not_found'); END IF;
    RETURN jsonb_build_object('status',403,'error','verified_subject_required');$new$),
    ('core.execution_command(text,jsonb)',
     $old$  ELSIF ctx ? 'dataSubject' THEN
    actor := core.resource_actor();$old$,
     $new$  ELSIF unit_key IS NOT NULL AND ctx ? 'dataSubject' THEN
    unit_consent:=execution_private.unit_consent(tenant,c->>'iss',ctx->>'dataSubject',unit_key,
      payload->'target'->>'capabilityId',ctx->>'purpose',NULL);
    IF unit_consent ? 'error' THEN RETURN jsonb_build_object('status',403,'error',unit_consent->>'error'); END IF;
    consent_key:=(unit_consent->>'consentId')::uuid;
  ELSIF ctx ? 'dataSubject' THEN
    actor := core.resource_actor();$new$),
    ('core.execution_command(text,jsonb)',
     $old$    RETURN jsonb_build_object('status',409,'error','idempotency_conflict');
  END IF;
  RETURN result;$old$,
     $new$    RETURN jsonb_build_object('status',409,'error','idempotency_conflict');
  ELSIF unit_key IS NOT NULL AND stored.data_subject IS NOT NULL THEN
    unit_consent:=execution_private.unit_consent(tenant,c->>'iss',stored.data_subject,unit_key,
      payload->'target'->>'capabilityId',stored.purpose,stored.consent_id);
    IF unit_consent ? 'error' THEN RETURN jsonb_build_object('status',403,'error',unit_consent->>'error'); END IF;
  END IF;
  RETURN result;$new$)
  ) AS edits(signature,old_text,new_text) LOOP
    source:=pg_get_functiondef(change.signature::regprocedure);
    IF (length(source)-length(replace(source,change.old_text,'')))<>length(change.old_text) THEN
      RAISE EXCEPTION 'Unexpected capability unit consent function %',change.signature;
    END IF;
    updated:=replace(source,change.old_text,change.new_text);
    EXECUTE updated;
  END LOOP;
END $migration$;

RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES(67);
NOTIFY pgrst,'reload schema';
COMMIT;
