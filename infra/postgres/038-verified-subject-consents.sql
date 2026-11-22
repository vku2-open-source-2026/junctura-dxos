-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
-- Consent under the verified subject identity. The caller's token must carry a
-- subjectId claim whose binding in (tenant, issuer) maps to the caller's login
-- subject; anything else is refused before any row is read. Consents granted
-- before verified subjects exist keep their authority through the same
-- binding: a person's rows are matched under both identifiers. Rows that no
-- allowed binding can reach stay quarantined for reconciliation.
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
GRANT USAGE ON SCHEMA core TO junctura_subject_api;
SET LOCAL ROLE junctura_app_owner;

-- Every identifier that names the same person: the given one plus, through an
-- allowed binding, the paired subjectId or login subject.
CREATE OR REPLACE FUNCTION execution_private.subject_variants(p_tenant text, p_issuer text, p_subject text) RETURNS text[]
LANGUAGE sql STABLE SET search_path=pg_catalog,app_private AS $$
  SELECT array_agg(DISTINCT v) FROM (
    SELECT p_subject AS v
    UNION SELECT b.subject_id FROM app_private.subject_bindings b
      WHERE b.tenant_id=p_tenant AND b.issuer=p_issuer AND b.login_subject=p_subject
    UNION SELECT b.login_subject FROM app_private.subject_bindings b
      WHERE b.tenant_id=p_tenant AND b.issuer=p_issuer AND b.subject_id=p_subject
  ) s
$$;

CREATE OR REPLACE FUNCTION execution_private.active_consent(p_tenant text, p_issuer text, p_subject text,
  p_consumer uuid, p_capability text, p_purpose text) RETURNS uuid
LANGUAGE sql STABLE SET search_path=pg_catalog,app_private AS $$
  SELECT s.consent_id FROM execution_private.subject_consents s
   WHERE s.tenant_id=p_tenant AND s.issuer=p_issuer
     AND s.data_subject=ANY(execution_private.subject_variants(p_tenant,p_issuer,p_subject))
     AND s.consumer_app_id=p_consumer AND s.capability_id=p_capability
     AND p_purpose = ANY(s.purposes) AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
   ORDER BY s.expires_at DESC, s.consent_id LIMIT 1
$$;

-- Idempotent consent grants: the first committed result of a key replays for
-- 24 hours; a different logical request under the same key is refused.
CREATE OR REPLACE FUNCTION core.subject_consent(operation text, payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private AS $$
DECLARE c jsonb; tenant text; who text; iss text; sid text; bound text;
  s execution_private.subject_consents; expiry timestamptz;
  purposes text[]; items jsonb; variants text[]; consent jsonb; receipt app_private.idempotency_results;
  scope bytea; digest bytea; idem_key uuid;
BEGIN
  BEGIN c:=current_setting('request.jwt.claims',true)::jsonb;
  EXCEPTION WHEN others THEN c:=NULL; END;
  tenant:=c->>'tenant_id'; who:=c->>'sub'; iss:=c->>'iss'; sid:=c->>'subject_id';
  IF c IS NULL OR tenant IS NULL OR tenant !~ '^[a-z][a-z0-9-]{0,62}$' OR coalesce(who,'')='' OR coalesce(iss,'')=''
     OR coalesce(sid,'')='' OR sid !~ '^[A-Za-z0-9:_-]{1,128}$' THEN
    RETURN jsonb_build_object('status',403,'error','verified_subject_required');
  END IF;
  -- The verified subject is the bound one: the claim must map to this login subject.
  SELECT b.login_subject INTO bound FROM app_private.subject_bindings b
    WHERE b.tenant_id=tenant AND b.issuer=iss AND b.subject_id=sid;
  IF bound IS NULL OR bound<>who THEN
    RETURN jsonb_build_object('status',403,'error','verified_subject_required');
  END IF;
  variants:=execution_private.subject_variants(tenant,iss,sid);
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('status',400,'error','invalid_consent'); END IF;
  IF operation='list' THEN
    IF payload<>'{}'::jsonb THEN RETURN jsonb_build_object('status',400,'error','invalid_consent'); END IF;
    SELECT coalesce(jsonb_agg(execution_private.consent_view(x) ORDER BY x.created_at DESC, x.consent_id),'[]'::jsonb) INTO items
      FROM (SELECT * FROM execution_private.subject_consents WHERE tenant_id=tenant AND issuer=iss
            AND data_subject=ANY(variants)
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
          AND data_subject=ANY(variants) AND revoked_at IS NULL AND expires_at>clock_timestamp()) >= 200 THEN
      RETURN jsonb_build_object('status',429,'error','consent_limit_reached');
    END IF;
    INSERT INTO execution_private.subject_consents(tenant_id, issuer, data_subject, consumer_app_id, capability_id, purposes, expires_at)
      VALUES (tenant, iss, sid, (consent->>'consumerAppId')::uuid, consent->>'capabilityId', purposes, expiry) RETURNING * INTO s;
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
      AND data_subject=ANY(variants) AND consent_id=(payload->>'consentId')::uuid FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('status',404,'error','not_found'); END IF;
    IF s.revoked_at IS NULL THEN
      UPDATE execution_private.subject_consents SET revoked_at=clock_timestamp()
        WHERE tenant_id=tenant AND consent_id=s.consent_id RETURNING * INTO s;
    END IF;
    RETURN jsonb_build_object('status',200,'value',execution_private.consent_view(s));
  END IF;
  RETURN jsonb_build_object('status',400,'error','invalid_operation');
END $$;

ALTER FUNCTION execution_private.subject_variants(text,text,text) OWNER TO junctura_app_owner;
ALTER FUNCTION execution_private.active_consent(text,text,text,uuid,text,text) OWNER TO junctura_app_owner;
REVOKE ALL ON FUNCTION execution_private.subject_variants(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION execution_private.active_consent(text,text,text,uuid,text,text) FROM PUBLIC;
ALTER FUNCTION core.subject_consent(text,jsonb) OWNER TO junctura_app_owner;
REVOKE ALL ON FUNCTION core.subject_consent(text,jsonb) FROM PUBLIC,junctura_api,junctura_app_api,junctura_resource_api,junctura_audit_api,junctura_trust_api,junctura_execution_api;
GRANT EXECUTE ON FUNCTION core.subject_consent(text,jsonb) TO junctura_subject_api;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (38);
NOTIFY pgrst, 'reload schema';
COMMIT;
