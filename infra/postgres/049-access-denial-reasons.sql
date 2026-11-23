-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

CREATE FUNCTION execution_private.consent_failure(p_tenant text,p_issuer text,p_subject text,p_kind text,
  p_consumer uuid,p_capability text,p_purpose text,p_consent uuid) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT coalesce((SELECT CASE WHEN s.revoked_at IS NOT NULL THEN 'consent_revoked' ELSE 'consent_expired' END
    FROM execution_private.subject_consents s
    WHERE s.tenant_id=p_tenant AND s.issuer=p_issuer
      AND CASE WHEN p_kind='canonical' THEN s.canonical_subject=p_subject ELSE s.data_subject=p_subject END
      AND s.consumer_app_id=p_consumer AND s.capability_id=p_capability AND p_purpose=ANY(s.purposes)
      AND (p_consent IS NULL OR s.consent_id=p_consent)
      AND (s.revoked_at IS NOT NULL OR s.expires_at<=statement_timestamp())
    ORDER BY s.created_at DESC,s.consent_id DESC LIMIT 1), 'consent_required')
$$;
REVOKE ALL ON FUNCTION execution_private.consent_failure(text,text,text,text,uuid,text,text,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION core.execution_command(operation text, payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  c jsonb := current_setting('request.jwt.claims',true)::jsonb;
  ctx jsonb; result jsonb; tenant text := c->>'tenant_id'; execution_key uuid; actor uuid; consent_key uuid;
  stored execution_private.execution_contexts; found_context boolean; is_emergency boolean;
  e execution_private.executions; open_emergencies integer; request_subject_kind text; failure text;
BEGIN
  IF operation IN ('ticket_context','redeem') AND jsonb_typeof(payload)='object' THEN
    -- Prove possession and provider identity before revealing why a consent failed.
    IF (execution_private.execution_command_base('ticket_context',payload)->'value'->>'active') IS DISTINCT FROM 'true' THEN
      RETURN jsonb_build_object('status',200,'value',jsonb_build_object('active',false));
    END IF;
    SELECT x.* INTO stored FROM execution_private.execution_contexts x
      WHERE x.tenant_id=tenant AND x.execution_id=(CASE WHEN payload->>'executionId' ~ '^[0-9a-f-]{36}$' THEN (payload->>'executionId')::uuid END);
    IF FOUND AND stored.data_subject IS NOT NULL AND NOT stored.emergency THEN
      SELECT x.* INTO e FROM execution_private.executions x WHERE x.tenant_id=tenant AND x.execution_id=stored.execution_id;
      IF execution_private.active_consent(tenant, e.issuer, stored.data_subject, stored.subject_kind,
          e.consumer_app_id, e.capability_id, stored.purpose, stored.consent_id) IS NULL THEN
        failure := execution_private.consent_failure(tenant,e.issuer,stored.data_subject,stored.subject_kind,
          e.consumer_app_id,e.capability_id,stored.purpose,stored.consent_id);
        RETURN jsonb_build_object('status',403,'error',failure);
      END IF;
    END IF;
    result := execution_private.execution_command_base(operation, payload);
    IF operation='redeem' AND result->'value'->>'active'='true' THEN
      SELECT x.* INTO stored FROM execution_private.execution_contexts x
        WHERE x.tenant_id=result->'value'->'context'->>'tenantId'
          AND x.execution_id=(result->'value'->'context'->>'executionId')::uuid;
      IF FOUND THEN
        result := jsonb_set(result, '{value,context}', (result->'value'->'context') ||
          jsonb_strip_nulls(jsonb_build_object('purpose', stored.purpose, 'dataSubject', stored.data_subject,
            'dataSubjectKind', CASE WHEN stored.subject_kind='canonical' THEN 'canonical' END,
            'emergency', CASE WHEN stored.emergency THEN true END)));
      END IF;
    END IF;
    RETURN result;
  END IF;
  IF operation IS DISTINCT FROM 'reserve' OR jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN
    RETURN execution_private.execution_command_base(operation, payload);
  END IF;

  ctx := payload->'context';
  IF ctx IS NOT NULL AND (
       jsonb_typeof(ctx) <> 'object' OR (ctx - 'purpose' - 'dataSubject' - 'dataSubjectKind' - 'emergency' - 'justification') <> '{}'::jsonb
       OR jsonb_typeof(ctx->'purpose') IS DISTINCT FROM 'string' OR ctx->>'purpose' !~ '^[a-z][a-z0-9_]{1,62}$'
       OR (ctx ? 'dataSubject' AND (jsonb_typeof(ctx->'dataSubject') <> 'string'
           OR length(ctx->>'dataSubject') NOT BETWEEN 1 AND 255 OR ctx->>'dataSubject' ~ '[[:cntrl:]]'))
       OR (ctx ? 'dataSubjectKind' AND (NOT ctx ? 'dataSubject'
           OR coalesce(ctx->>'dataSubjectKind','') NOT IN ('login','canonical')))
       OR (ctx ? 'emergency' AND ctx->'emergency' IS DISTINCT FROM 'true'::jsonb)
       OR ((ctx ? 'emergency') <> (ctx ? 'justification'))
       OR (ctx ? 'emergency' AND NOT ctx ? 'dataSubject')
       OR (ctx ? 'justification' AND (jsonb_typeof(ctx->'justification') <> 'string'
           OR length(ctx->>'justification') NOT BETWEEN 10 AND 500 OR ctx->>'justification' ~ '[[:cntrl:]]'))) THEN
    RETURN jsonb_build_object('status',400,'error','invalid_execution_context');
  END IF;
  IF ctx ? 'dataSubject' THEN request_subject_kind:=coalesce(ctx->>'dataSubjectKind','login'); END IF;
  IF request_subject_kind='canonical' AND NOT EXISTS (SELECT FROM app_private.subject_bindings b
      WHERE b.tenant_id=tenant AND b.issuer=c->>'iss' AND b.subject_id=ctx->>'dataSubject') THEN
    RETURN jsonb_build_object('status',403,'error','verified_subject_required');
  END IF;
  is_emergency := coalesce(ctx->'emergency' = 'true'::jsonb, false);

  IF is_emergency THEN
    -- Bounded break-glass use: at most five unreviewed emergency calls per consumer.
    actor := core.resource_actor();
    SELECT count(*) INTO open_emergencies FROM execution_private.emergency_reviews r
      JOIN execution_private.executions x ON x.tenant_id=r.tenant_id AND x.execution_id=r.execution_id
      WHERE r.tenant_id=tenant AND r.state='pending' AND x.consumer_app_id=actor;
    IF open_emergencies >= 5 THEN RETURN jsonb_build_object('status',429,'error','emergency_review_backlog'); END IF;
  ELSIF ctx ? 'dataSubject' THEN
    actor := core.resource_actor();
    consent_key := execution_private.active_consent(tenant, c->>'iss', ctx->>'dataSubject', request_subject_kind, actor,
      payload->'target'->>'capabilityId', ctx->>'purpose', NULL);
    IF consent_key IS NULL THEN
      failure:=execution_private.consent_failure(tenant,c->>'iss',ctx->>'dataSubject',request_subject_kind,actor,
        payload->'target'->>'capabilityId',ctx->>'purpose',NULL);
      RETURN jsonb_build_object('status',403,'error',failure);
    END IF;
  END IF;

  result := execution_private.execution_command_base('reserve', payload - 'context');
  IF result->>'status' NOT IN ('200','202') THEN RETURN result; END IF;
  execution_key := (result->'value'->>'executionId')::uuid;
  SELECT x.* INTO stored FROM execution_private.execution_contexts x WHERE x.tenant_id=tenant AND x.execution_id=execution_key;
  found_context := FOUND;

  IF result->>'status' = '202' THEN
    IF ctx IS NOT NULL THEN
      INSERT INTO execution_private.execution_contexts(tenant_id, execution_id, purpose, data_subject, subject_kind, emergency, justification, consent_id)
        VALUES (tenant, execution_key, ctx->>'purpose', ctx->>'dataSubject', request_subject_kind, is_emergency, ctx->>'justification', consent_key);
      PERFORM app_private.audit_append(CASE WHEN is_emergency THEN 'execution.emergency_access' ELSE 'execution.subject_accessed' END,
        'execution', execution_key, 1, 'success', ctx->>'purpose', CASE WHEN ctx ? 'dataSubject'
          THEN 'data_subject_sha256:' || encode(sha256(convert_to(
            CASE WHEN request_subject_kind='canonical' THEN jsonb_build_array(request_subject_kind,ctx->>'dataSubject')::text
                 ELSE ctx->>'dataSubject' END,'UTF8')),'hex') END);
      IF is_emergency THEN
        INSERT INTO execution_private.emergency_reviews(tenant_id, execution_id) VALUES (tenant, execution_key);
      END IF;
    END IF;
  ELSIF found_context <> (ctx IS NOT NULL)
     OR (found_context AND (stored.purpose IS DISTINCT FROM ctx->>'purpose'
                            OR stored.data_subject IS DISTINCT FROM ctx->>'dataSubject'
                            OR coalesce(stored.subject_kind,'login') IS DISTINCT FROM
                               coalesce(request_subject_kind,'login')
                            OR stored.emergency IS DISTINCT FROM is_emergency
                            OR stored.justification IS DISTINCT FROM ctx->>'justification')) THEN
    RETURN jsonb_build_object('status',409,'error','idempotency_conflict');
  END IF;
  RETURN result;
END $$;

RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (49);
NOTIFY pgrst,'reload schema';
COMMIT;
