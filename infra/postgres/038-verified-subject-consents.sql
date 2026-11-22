-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
-- Legacy rows have a login subject. Canonical consent authority requires a
-- binding, and historical access contexts have no explicit identifier kind.
GRANT CREATE ON SCHEMA core TO junctura_app_owner;

ALTER TABLE execution_private.subject_consents ADD COLUMN canonical_subject text;
CREATE INDEX subject_consents_canonical_idx
  ON execution_private.subject_consents (tenant_id, issuer, canonical_subject) WHERE revoked_at IS NULL;
ALTER TABLE execution_private.execution_contexts ADD COLUMN subject_kind text
  CHECK (subject_kind IS NULL OR (subject_kind IN ('login','canonical') AND data_subject IS NOT NULL));
UPDATE execution_private.subject_consents s SET canonical_subject=b.subject_id
  FROM app_private.subject_bindings b
  WHERE (s.tenant_id,s.issuer,s.data_subject)=(b.tenant_id,b.issuer,b.login_subject);

SET LOCAL ROLE junctura_app_owner;

-- Lock the selected grant through reservation or redemption. Revoke takes
-- an incompatible row lock, and a ticket with a grant stays pinned to it.
CREATE FUNCTION execution_private.active_consent(p_tenant text, p_issuer text, p_subject text, p_kind text,
  p_consumer uuid, p_capability text, p_purpose text, p_consent uuid) RETURNS uuid
LANGUAGE sql SET search_path=pg_catalog AS $$
  SELECT s.consent_id FROM execution_private.subject_consents s
   WHERE s.tenant_id=p_tenant AND s.issuer=p_issuer
     AND ((p_kind='canonical' AND s.canonical_subject=p_subject)
         OR (coalesce(p_kind,'login')='login' AND s.data_subject=p_subject))
     AND (p_consent IS NULL OR s.consent_id=p_consent)
     AND s.consumer_app_id=p_consumer AND s.capability_id=p_capability
     AND p_purpose=ANY(s.purposes) AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
   ORDER BY s.expires_at DESC, s.consent_id LIMIT 1 FOR SHARE
$$;
REVOKE ALL ON FUNCTION execution_private.active_consent(text,text,text,text,uuid,text,text,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION core.execution_command(operation text, payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  c jsonb := current_setting('request.jwt.claims',true)::jsonb;
  ctx jsonb; result jsonb; tenant text := c->>'tenant_id'; execution uuid; actor uuid; consent uuid;
  stored execution_private.execution_contexts; found_context boolean; emergency boolean;
  e execution_private.executions; open_emergencies integer; subject_kind text;
BEGIN
  IF operation IN ('ticket_context','redeem') AND jsonb_typeof(payload)='object' THEN
    -- Consent is re-checked before the provider receives authority.
    SELECT x.* INTO stored FROM execution_private.execution_contexts x
      WHERE x.tenant_id=tenant AND x.execution_id=(CASE WHEN payload->>'executionId' ~ '^[0-9a-f-]{36}$' THEN (payload->>'executionId')::uuid END);
    IF FOUND AND stored.data_subject IS NOT NULL AND NOT stored.emergency THEN
      SELECT * INTO e FROM execution_private.executions WHERE tenant_id=tenant AND execution_id=stored.execution_id;
      IF execution_private.active_consent(tenant, e.issuer, stored.data_subject, stored.subject_kind,
          e.consumer_app_id, e.capability_id, stored.purpose, stored.consent_id) IS NULL THEN
        RETURN jsonb_build_object('status',200,'value',jsonb_build_object('active',false));
      END IF;
    END IF;
    result := execution_private.execution_command_base(operation, payload);
    IF operation='redeem' AND result->'value'->>'active'='true' THEN
      SELECT * INTO stored FROM execution_private.execution_contexts
        WHERE tenant_id=result->'value'->'context'->>'tenantId'
          AND execution_id=(result->'value'->'context'->>'executionId')::uuid;
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
  IF ctx ? 'dataSubject' THEN subject_kind:=coalesce(ctx->>'dataSubjectKind','login'); END IF;
  IF subject_kind='canonical' AND NOT EXISTS (SELECT FROM app_private.subject_bindings b
      WHERE b.tenant_id=tenant AND b.issuer=c->>'iss' AND b.subject_id=ctx->>'dataSubject') THEN
    RETURN jsonb_build_object('status',403,'error','verified_subject_required');
  END IF;
  emergency := coalesce(ctx->'emergency' = 'true'::jsonb, false);

  IF emergency THEN
    -- Bounded break-glass use: at most five unreviewed emergency calls per consumer.
    actor := core.resource_actor();
    SELECT count(*) INTO open_emergencies FROM execution_private.emergency_reviews r
      JOIN execution_private.executions x ON x.tenant_id=r.tenant_id AND x.execution_id=r.execution_id
      WHERE r.tenant_id=tenant AND r.state='pending' AND x.consumer_app_id=actor;
    IF open_emergencies >= 5 THEN RETURN jsonb_build_object('status',429,'error','emergency_review_backlog'); END IF;
  ELSIF ctx ? 'dataSubject' THEN
    actor := core.resource_actor();
    consent := execution_private.active_consent(tenant, c->>'iss', ctx->>'dataSubject', subject_kind, actor,
      payload->'target'->>'capabilityId', ctx->>'purpose', NULL);
    IF consent IS NULL THEN RETURN jsonb_build_object('status',403,'error','subject_consent_required'); END IF;
  END IF;

  result := execution_private.execution_command_base('reserve', payload - 'context');
  IF result->>'status' NOT IN ('200','202') THEN RETURN result; END IF;
  execution := (result->'value'->>'executionId')::uuid;
  SELECT * INTO stored FROM execution_private.execution_contexts WHERE tenant_id=tenant AND execution_id=execution;
  found_context := FOUND;

  IF result->>'status' = '202' THEN
    IF ctx IS NOT NULL THEN
      INSERT INTO execution_private.execution_contexts(tenant_id, execution_id, purpose, data_subject, subject_kind, emergency, justification, consent_id)
        VALUES (tenant, execution, ctx->>'purpose', ctx->>'dataSubject', subject_kind, emergency, ctx->>'justification', consent);
      PERFORM app_private.audit_append(CASE WHEN emergency THEN 'execution.emergency_access' ELSE 'execution.subject_accessed' END,
        'execution', execution, 1, 'success', ctx->>'purpose', CASE WHEN ctx ? 'dataSubject'
          THEN 'data_subject_sha256:' || encode(sha256(convert_to(
            CASE WHEN subject_kind='canonical' THEN jsonb_build_array(subject_kind,ctx->>'dataSubject')::text
                 ELSE ctx->>'dataSubject' END,'UTF8')),'hex') END);
      IF emergency THEN
        INSERT INTO execution_private.emergency_reviews(tenant_id, execution_id) VALUES (tenant, execution);
      END IF;
    END IF;
  ELSIF found_context <> (ctx IS NOT NULL)
     OR (found_context AND (stored.purpose IS DISTINCT FROM ctx->>'purpose'
                            OR stored.data_subject IS DISTINCT FROM ctx->>'dataSubject'
                            OR coalesce(stored.subject_kind,'login') IS DISTINCT FROM
                               coalesce(subject_kind,'login')
                            OR stored.emergency IS DISTINCT FROM emergency
                            OR stored.justification IS DISTINCT FROM ctx->>'justification')) THEN
    RETURN jsonb_build_object('status',409,'error','idempotency_conflict');
  END IF;
  RETURN result;
END $$;
ALTER FUNCTION core.execution_command(text,jsonb) OWNER TO junctura_app_owner;
REVOKE ALL ON FUNCTION core.execution_command(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.execution_command(text,jsonb) TO junctura_execution_api;

DROP FUNCTION execution_private.active_consent(text,text,text,uuid,text,text);

-- Idempotent consent grants: the first committed result of a key replays for
-- 24 hours; a different logical request under the same key is refused. The
-- per-subject active-consent limit counts and creates under a separate
-- transaction lock so two different keys cannot both pass the same count.
CREATE OR REPLACE FUNCTION core.subject_consent(operation text, payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private AS $$
DECLARE c jsonb; tenant text; who text; iss text; sid text; bound text;
  s execution_private.subject_consents; expiry timestamptz;
  purposes text[]; items jsonb; consent jsonb; receipt app_private.idempotency_results;
  scope bytea; digest bytea; idem_key uuid;
BEGIN
  BEGIN c:=current_setting('request.jwt.claims',true)::jsonb;
  EXCEPTION WHEN others THEN c:=NULL; END;
  tenant:=c->>'tenant_id'; who:=c->>'sub'; iss:=c->>'iss'; sid:=c->>'subject_id';
  IF c IS NULL OR tenant IS NULL OR tenant !~ '^[a-z][a-z0-9-]{0,62}$' OR coalesce(who,'')='' OR coalesce(iss,'')='' THEN
    RETURN jsonb_build_object('status',403,'error','verified_subject_required');
  END IF;
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('status',400,'error','invalid_consent'); END IF;
  IF operation='create' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(
      'subject-consent-limit',tenant,iss,who)::text,0));
  END IF;
  SELECT b.subject_id INTO bound FROM app_private.subject_bindings b
    WHERE b.tenant_id=tenant AND b.issuer=iss AND b.login_subject=who;
  IF sid IS NOT NULL AND sid IS DISTINCT FROM bound THEN
    RETURN jsonb_build_object('status',403,'error','verified_subject_required');
  END IF;
  IF operation='list' THEN
    IF payload<>'{}'::jsonb THEN RETURN jsonb_build_object('status',400,'error','invalid_consent'); END IF;
    SELECT coalesce(jsonb_agg(execution_private.consent_view(x) ORDER BY x.created_at DESC, x.consent_id),'[]'::jsonb) INTO items
      FROM (SELECT * FROM execution_private.subject_consents WHERE tenant_id=tenant AND issuer=iss
            AND data_subject=who
            ORDER BY created_at DESC, consent_id LIMIT 200) x;
    RETURN jsonb_build_object('status',200,'value',jsonb_build_object('consents',items));
  ELSIF operation='create' THEN
    IF (payload - 'consent' - 'key' - 'digest') <> '{}'::jsonb
       OR jsonb_typeof(payload->'consent') IS DISTINCT FROM 'object'
       OR coalesce(payload->>'key','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(payload->>'digest','') !~ '^[0-9a-f]{64}$' THEN
      RETURN jsonb_build_object('status',400,'error','invalid_consent');
    END IF;
    consent:=payload->'consent'; idem_key:=(payload->>'key')::uuid;
    digest:=decode(payload->>'digest','hex');
    scope:=sha256(convert_to(jsonb_build_array(iss,who,c->>'client_id','subject-consent')::text,'UTF8'));
    PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(
      'subject-consent-receipt',tenant,encode(scope,'hex'),idem_key)::text,0));
    SELECT * INTO receipt FROM app_private.idempotency_results
      WHERE tenant_id=tenant AND caller_scope=scope AND method='POST'
        AND concrete_path='/v1/me/consents' AND key=idem_key FOR UPDATE;
    IF FOUND AND receipt.expires_at>clock_timestamp() THEN
      IF receipt.digest<>digest THEN
        RETURN jsonb_build_object('status',422,'error','idempotency_key_reused');
      END IF;
      RETURN jsonb_build_object('status',receipt.status,'value',receipt.response_body->'value',
        'headers',receipt.resource_headers);
    END IF;
    DELETE FROM app_private.idempotency_results WHERE tenant_id=tenant AND caller_scope=scope
      AND method='POST' AND concrete_path='/v1/me/consents' AND key=idem_key;
    IF (payload - 'consent' - 'key' - 'digest') <> '{}'::jsonb
       OR coalesce(consent->>'consumerAppId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(consent->>'capabilityId','') !~ '^urn:junctura:capability:[0-9a-f-]{36}:[a-z][a-z0-9-]{0,62}$'
       OR jsonb_typeof(consent->'purposes') IS DISTINCT FROM 'array'
       OR jsonb_array_length(consent->'purposes') NOT BETWEEN 1 AND 8
       OR EXISTS (SELECT FROM jsonb_array_elements(consent->'purposes') p WHERE jsonb_typeof(p)<>'string' OR p#>>'{}' !~ '^[a-z][a-z0-9_]{1,62}$')
       OR jsonb_typeof(consent->'expiresAt') IS DISTINCT FROM 'string' THEN
      RETURN jsonb_build_object('status',400,'error','invalid_consent');
    END IF;
    BEGIN expiry := (consent->>'expiresAt')::timestamptz;
    EXCEPTION WHEN others THEN RETURN jsonb_build_object('status',400,'error','invalid_consent'); END;
    IF expiry <= clock_timestamp() OR expiry > clock_timestamp() + interval '366 days' THEN
      RETURN jsonb_build_object('status',400,'error','invalid_consent_expiry');
    END IF;
    SELECT array_agg(DISTINCT p ORDER BY p) INTO purposes FROM jsonb_array_elements_text(consent->'purposes') p;
    IF NOT EXISTS (SELECT FROM app_private.applications a WHERE a.tenant_id=tenant AND a.issuer=iss
                     AND a.app_id=(consent->>'consumerAppId')::uuid AND a.state='active')
       OR NOT EXISTS (SELECT FROM app_private.capability_versions v WHERE v.tenant_id=tenant
                     AND v.capability_id=consent->>'capabilityId' AND v.state IN ('published','deprecated')) THEN
      RETURN jsonb_build_object('status',404,'error','not_found');
    END IF;
    IF (SELECT count(*) FROM execution_private.subject_consents WHERE tenant_id=tenant AND issuer=iss
          AND data_subject=who AND revoked_at IS NULL AND expires_at>clock_timestamp()) >= 200 THEN
      RETURN jsonb_build_object('status',429,'error','consent_limit_reached');
    END IF;
    INSERT INTO execution_private.subject_consents(tenant_id, issuer, data_subject, canonical_subject,
        consumer_app_id, capability_id, purposes, expires_at)
      VALUES (tenant, iss, who, bound, (consent->>'consumerAppId')::uuid, consent->>'capabilityId', purposes, expiry) RETURNING * INTO s;
    items:=jsonb_build_object('status',201,'value',execution_private.consent_view(s));
    INSERT INTO app_private.idempotency_results(tenant_id, caller_scope, method, concrete_path, key, digest,
        status, response_body, resource_headers, created_at, expires_at)
      VALUES (tenant, scope, 'POST', '/v1/me/consents', idem_key, digest, 201,
        jsonb_build_object('value',execution_private.consent_view(s)),
        jsonb_build_object('Location','/v1/me/consents/'||s.consent_id), clock_timestamp(), clock_timestamp()+interval '24 hours');
    RETURN items;
  ELSIF operation='revoke' THEN
    IF (payload - 'consentId') <> '{}'::jsonb OR coalesce(payload->>'consentId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN jsonb_build_object('status',400,'error','invalid_consent');
    END IF;
    SELECT * INTO s FROM execution_private.subject_consents WHERE tenant_id=tenant AND issuer=iss
      AND data_subject=who AND consent_id=(payload->>'consentId')::uuid FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('status',404,'error','not_found'); END IF;
    IF s.revoked_at IS NULL THEN
      UPDATE execution_private.subject_consents SET revoked_at=clock_timestamp()
        WHERE tenant_id=tenant AND consent_id=s.consent_id RETURNING * INTO s;
    END IF;
    RETURN jsonb_build_object('status',200,'value',execution_private.consent_view(s));
  END IF;
  RETURN jsonb_build_object('status',400,'error','invalid_operation');
END $$;

-- A canonical event is visible only through the caller's own login binding.
-- Untyped historical values that could refer to either namespace are held
-- for reconciliation unless their stored legacy grant establishes the kind.
CREATE OR REPLACE FUNCTION core.subject_access(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $$
DECLARE c jsonb; tenant text; who text; iss text; sid text; items jsonb; total integer;
  max_items constant integer := 200;
BEGIN
  IF payload IS NULL OR jsonb_typeof(payload)<>'object' OR payload<>'{}'::jsonb THEN
    RETURN jsonb_build_object('status',400,'error','invalid_subject_access_request');
  END IF;
  BEGIN c:=current_setting('request.jwt.claims',true)::jsonb;
  EXCEPTION WHEN others THEN c:=NULL; END;
  tenant:=c->>'tenant_id'; who:=c->>'sub'; iss:=c->>'iss';
  IF c IS NULL OR tenant IS NULL OR tenant !~ '^[a-z][a-z0-9-]{0,62}$' OR coalesce(who,'')='' OR coalesce(iss,'')='' THEN
    RETURN jsonb_build_object('status',403,'error','verified_subject_required');
  END IF;
  SELECT b.subject_id INTO sid FROM app_private.subject_bindings b
    WHERE b.tenant_id=tenant AND b.issuer=iss AND b.login_subject=who;
  WITH mine AS (
    SELECT x.*, e.consumer_app_id, e.provider_app_id, e.capability_id, e.version, e.version_id, e.state,
           r.state AS review_state
      FROM execution_private.execution_contexts x
      JOIN execution_private.executions e ON e.tenant_id=x.tenant_id AND e.execution_id=x.execution_id
      LEFT JOIN execution_private.emergency_reviews r ON r.tenant_id=x.tenant_id AND r.execution_id=x.execution_id
      WHERE x.tenant_id=tenant AND e.issuer=iss
        AND ((x.subject_kind='canonical' AND x.data_subject=sid)
          OR (x.data_subject=who AND (x.subject_kind='login' OR (x.subject_kind IS NULL AND
            (x.consent_id IS NOT NULL OR NOT EXISTS (SELECT FROM app_private.subject_bindings b
                WHERE b.tenant_id=tenant AND b.issuer=iss AND b.subject_id=who))))))
  ), newest AS (SELECT * FROM mine ORDER BY recorded_at DESC, execution_id LIMIT max_items)
  SELECT (SELECT count(*) FROM mine), coalesce(jsonb_agg(jsonb_build_object(
      'executionId', n.execution_id,
      'accessedAt', to_char(n.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'purpose', n.purpose,
      'state', n.state,
      'emergency', n.emergency,
      'review', n.review_state,
      'consumer', jsonb_build_object('appId', n.consumer_app_id, 'displayName',
        (SELECT a.display_name FROM app_private.applications a WHERE a.tenant_id=n.tenant_id AND a.app_id=n.consumer_app_id)),
      'provider', jsonb_build_object('appId', n.provider_app_id, 'displayName',
        (SELECT a.display_name FROM app_private.applications a WHERE a.tenant_id=n.tenant_id AND a.app_id=n.provider_app_id)),
      'capability', jsonb_build_object('capabilityId', n.capability_id, 'version', n.version, 'title',
        (SELECT v.manifest->>'title' FROM app_private.capability_versions v WHERE v.tenant_id=n.tenant_id AND v.version_id=n.version_id)))
      ORDER BY n.recorded_at DESC, n.execution_id), '[]'::jsonb)
    INTO total, items FROM newest n;
  RETURN jsonb_build_object('status',200,'value',jsonb_build_object(
    'entries', items, 'truncated', total > max_items,
    'generatedAt', to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
END $$;

-- A binding created after the upgrade maps that login's quarantined legacy
-- consents to the bound subjectId, so operators can reconcile one login at a time.
CREATE OR REPLACE FUNCTION app_private.subject_binding_map_consents() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app_private AS $$
DECLARE original text := current_setting('request.jwt.claims', true);
BEGIN
  PERFORM set_config('request.jwt.claims', jsonb_build_object('tenant_id', NEW.tenant_id)::text, true);
  UPDATE execution_private.subject_consents s SET canonical_subject = NEW.subject_id
    WHERE s.tenant_id = NEW.tenant_id AND s.issuer = NEW.issuer
      AND s.data_subject = NEW.login_subject AND s.canonical_subject IS NULL;
  PERFORM set_config('request.jwt.claims', coalesce(original, ''), true);
  RETURN NEW;
END $$;
ALTER FUNCTION app_private.subject_binding_map_consents() OWNER TO junctura_app_owner;
REVOKE ALL ON FUNCTION app_private.subject_binding_map_consents() FROM PUBLIC;
CREATE TRIGGER subject_binding_map_consents AFTER INSERT ON app_private.subject_bindings
  FOR EACH ROW EXECUTE FUNCTION app_private.subject_binding_map_consents();
RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (38);
NOTIFY pgrst, 'reload schema';
COMMIT;
