-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
-- Data subject access reports and emergency feedback. A report is a separate
-- row keyed by the visible access event; the audit chain and the management
-- review stay untouched. Retrying the same reason replays the original report,
-- a changed reason conflicts, and only events visible to the caller's own
-- bound subject can be reported. Concurrent writers of the same report or
-- feedback race through one INSERT and read the winning row, so a loser
-- replays or conflicts instead of failing. The page key keeps full timestamp
-- precision so same-instant entries never fall between cursor pages.
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

CREATE TABLE app_private.subject_access_reports (
  tenant_id text NOT NULL DEFAULT(current_setting('request.jwt.claims',true)::jsonb->>'tenant_id'),
  access_kind text NOT NULL CHECK(access_kind IN ('capability','app')),
  access_id uuid NOT NULL,
  reason text NOT NULL CHECK(reason IN ('unrecognized','other')),
  reported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reported_by text NOT NULL,
  subject_id text NOT NULL,
  issuer text NOT NULL,
  PRIMARY KEY(tenant_id, access_kind, access_id)
);
ALTER TABLE app_private.subject_access_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.subject_access_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app_private.subject_access_reports TO junctura_app_owner
  USING(tenant_id=current_setting('request.jwt.claims',true)::jsonb->>'tenant_id')
  WITH CHECK(tenant_id=current_setting('request.jwt.claims',true)::jsonb->>'tenant_id');
REVOKE ALL ON app_private.subject_access_reports FROM PUBLIC;

CREATE TABLE app_private.emergency_feedback (
  tenant_id text NOT NULL DEFAULT(current_setting('request.jwt.claims',true)::jsonb->>'tenant_id'),
  execution_id uuid NOT NULL,
  decision text NOT NULL CHECK(decision IN ('recognized','unrecognized','other')),
  message text CHECK(message IS NULL OR (length(message) BETWEEN 1 AND 500 AND message !~ '[[:cntrl:]]')),
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  submitted_by text NOT NULL,
  subject_id text NOT NULL,
  issuer text NOT NULL,
  PRIMARY KEY(tenant_id, execution_id)
);
ALTER TABLE app_private.emergency_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.emergency_feedback FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app_private.emergency_feedback TO junctura_app_owner
  USING(tenant_id=current_setting('request.jwt.claims',true)::jsonb->>'tenant_id')
  WITH CHECK(tenant_id=current_setting('request.jwt.claims',true)::jsonb->>'tenant_id');
REVOKE ALL ON app_private.emergency_feedback FROM PUBLIC;

-- The merged history answers only through the verified caller: the login
-- subject must be bound to the canonical subjectId that the access events
-- name. Flagging reuses exactly this predicate.
CREATE FUNCTION core.subject_access_command(operation text, payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private
SET lock_timeout='2s' SET timezone='UTC' AS $$
DECLARE
  claims jsonb := current_setting('request.jwt.claims', true)::jsonb;
  tenant text := claims->>'tenant_id';
  who text := claims->>'sub';
  iss text := claims->>'iss';
  sid text;
  kind text;
  access uuid;
  visible boolean;
  existing app_private.subject_access_reports;
  feedback app_private.emergency_feedback;
  rows jsonb;
BEGIN
  IF nullif(who, '') IS NULL OR nullif(iss, '') IS NULL OR nullif(tenant, '') IS NULL
    OR tenant !~ '^[a-z][a-z0-9-]{0,62}$' THEN
    RETURN jsonb_build_object('status', 403, 'error', 'verified_subject_required');
  END IF;
  SELECT b.subject_id INTO sid FROM app_private.subject_bindings b
    WHERE b.tenant_id=tenant AND b.issuer=iss AND b.login_subject=who;
  IF sid IS NULL OR nullif(claims->>'subject_id', '') IS DISTINCT FROM sid THEN
    RETURN jsonb_build_object('status', 403, 'error', 'verified_subject_required');
  END IF;
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('status', 400, 'error', 'invalid_request');
  END IF;

  IF operation = 'list' THEN
    -- Capability calls naming this subject plus application events declared
    -- visible at append time; one page, newest first, stable accessId order.
    IF coalesce(payload->>'limit', '200') !~ '^[0-9]+$' OR (payload->>'limit')::integer NOT BETWEEN 1 AND 200
      OR (payload - 'limit' - 'after') <> '{}'::jsonb
      OR (payload ? 'after' AND (jsonb_typeof(payload->'after') IS DISTINCT FROM 'object'
        OR (payload->'after' - 'accessedAt' - 'accessId') <> '{}'::jsonb
        OR jsonb_typeof(payload->'after'->'accessedAt') IS DISTINCT FROM 'string'
        OR payload->'after'->>'accessedAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$'
        OR jsonb_typeof(payload->'after'->'accessId') IS DISTINCT FROM 'string'
        OR payload->'after'->>'accessId' !~ '^(capability|app):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) THEN
      RETURN jsonb_build_object('status', 400, 'error', 'invalid_request');
    END IF;
    SELECT coalesce(jsonb_agg(entry ORDER BY accessed_at DESC, access_id DESC), '[]'::jsonb)
      INTO rows
    FROM (
      SELECT entry, accessed_at, access_id FROM (
        SELECT jsonb_build_object(
            'source', 'capability', 'accessId', 'capability:' || x.execution_id::text,
            'executionId', x.execution_id, 'accessedAt', to_char(x.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'purpose', x.purpose, 'flaggedAt', to_char(r.reported_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'state', e.state, 'emergency', x.emergency, 'review', rv.state,
            'consumer', jsonb_build_object('appId', e.consumer_app_id, 'displayName',
              (SELECT a.display_name FROM app_private.applications a
                WHERE a.tenant_id=x.tenant_id AND a.app_id=e.consumer_app_id)),
            'provider', jsonb_build_object('appId', e.provider_app_id, 'displayName',
              (SELECT a.display_name FROM app_private.applications a
                WHERE a.tenant_id=x.tenant_id AND a.app_id=e.provider_app_id)),
            'capability', jsonb_build_object('capabilityId', e.capability_id, 'version', e.version, 'title',
              (SELECT v.manifest->>'title' FROM app_private.capability_versions v
                WHERE v.tenant_id=x.tenant_id AND v.version_id=e.version_id))) AS entry,
          x.recorded_at AS accessed_at, 'capability:' || x.execution_id::text AS access_id
        FROM execution_private.execution_contexts x
        JOIN execution_private.executions e ON e.tenant_id=x.tenant_id AND e.execution_id=x.execution_id
        LEFT JOIN execution_private.emergency_reviews rv ON rv.tenant_id=x.tenant_id AND rv.execution_id=x.execution_id
        LEFT JOIN app_private.subject_access_reports r
          ON r.tenant_id=x.tenant_id AND r.access_kind='capability' AND r.access_id=x.execution_id
        WHERE x.tenant_id=tenant AND e.issuer=iss
          AND ((x.subject_kind='canonical' AND x.data_subject=sid)
            OR (x.data_subject=who AND (x.subject_kind='login' OR (x.subject_kind IS NULL AND
              (x.consent_id IS NOT NULL OR NOT EXISTS (SELECT FROM app_private.subject_bindings b2
                WHERE b2.tenant_id=tenant AND b2.issuer=iss AND b2.subject_id=who))))))
        UNION ALL
        SELECT jsonb_build_object(
            'source', 'application', 'accessId', 'app:' || s.event_id::text,
            'accessedAt', to_char(s.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'purpose', s.purpose, 'flaggedAt', to_char(r.reported_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'app', jsonb_build_object('appId', s.app_id, 'displayName',
              (SELECT a.display_name FROM app_private.applications a
                WHERE a.tenant_id=tenant AND a.app_id=s.app_id)),
            'action', s.action, 'outcome', s.outcome) AS entry,
          s.occurred_at AS accessed_at, 'app:' || s.event_id::text AS access_id
        FROM app_private.audit_subject_entries(sid) s
        LEFT JOIN app_private.subject_access_reports r
          ON r.tenant_id=tenant AND r.access_kind='app' AND r.access_id=s.event_id
        WHERE s.outcome <> 'unknown'
      ) merged
      WHERE (payload->>'after' IS NULL OR (accessed_at, access_id) <
        ((payload->'after'->>'accessedAt')::timestamptz, payload->'after'->>'accessId'))
      ORDER BY accessed_at DESC, access_id DESC
      LIMIT (payload->>'limit')::integer + 1
    ) page;
    RETURN jsonb_build_object('status', 200, 'value', jsonb_build_object(
      'entries', CASE WHEN jsonb_array_length(rows) > (payload->>'limit')::integer
        THEN rows - (jsonb_array_length(rows) - 1) ELSE rows END,
      'truncated', jsonb_array_length(rows) > (payload->>'limit')::integer,
      'generatedAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  END IF;

  IF operation = 'flag' THEN
    IF (payload - 'accessId' - 'reason') <> '{}'::jsonb
      OR coalesce(payload->>'accessId', '') !~ '^(capability|app):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR payload->>'reason' NOT IN ('unrecognized', 'other') THEN
      RETURN jsonb_build_object('status', 400, 'error', 'invalid_request');
    END IF;
    kind := split_part(payload->>'accessId', ':', 1);
    access := (split_part(payload->>'accessId', ':', 2))::uuid;
    -- The flag checks the exact same visibility predicate as the history.
    IF kind = 'app' THEN
      SELECT EXISTS(SELECT FROM app_private.audit_subject_entries(sid) s
        WHERE s.event_id=access AND s.outcome <> 'unknown') INTO visible;
    ELSE
      SELECT EXISTS(
        SELECT FROM execution_private.execution_contexts x
        JOIN execution_private.executions e ON e.tenant_id=x.tenant_id AND e.execution_id=x.execution_id
        WHERE x.tenant_id=tenant AND x.execution_id=access AND e.issuer=iss
          AND ((x.subject_kind='canonical' AND x.data_subject=sid)
            OR (x.data_subject=who AND (x.subject_kind='login' OR (x.subject_kind IS NULL AND
              (x.consent_id IS NOT NULL OR NOT EXISTS (SELECT FROM app_private.subject_bindings b2
                WHERE b2.tenant_id=tenant AND b2.issuer=iss AND b2.subject_id=who))))))) INTO visible;
    END IF;
    IF NOT visible THEN RETURN jsonb_build_object('status', 404, 'error', 'not_found'); END IF;
    -- SELECT ... FOR UPDATE cannot lock a row that does not exist yet, so two
    -- concurrent reports both try one INSERT; the loser reads the winning row
    -- and answers replay or conflict instead of a unique violation.
    INSERT INTO app_private.subject_access_reports(tenant_id, access_kind, access_id, reason, reported_by, subject_id, issuer)
      VALUES (tenant, kind, access, payload->>'reason', who, sid, iss)
      ON CONFLICT DO NOTHING
      RETURNING * INTO existing;
    IF FOUND THEN
      RETURN jsonb_build_object('status', 201, 'value', jsonb_build_object(
        'accessId', payload->>'accessId',
        'flaggedAt', to_char(existing.reported_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
    END IF;
    SELECT * INTO existing FROM app_private.subject_access_reports
      WHERE tenant_id=tenant AND access_kind=kind AND access_id=access;
    IF NOT FOUND THEN RETURN jsonb_build_object('status', 503, 'error', 'subject_access_unavailable'); END IF;
    IF existing.reason <> payload->>'reason' THEN
      RETURN jsonb_build_object('status', 409, 'error', 'resource_conflict',
        'details', jsonb_build_object('flaggedAt', to_char(existing.reported_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
    END IF;
    RETURN jsonb_build_object('status', 200, 'value', jsonb_build_object(
      'accessId', payload->>'accessId',
      'flaggedAt', to_char(existing.reported_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  END IF;

  IF operation = 'feedback' THEN
    IF (payload - 'executionId' - 'decision' - 'message') <> '{}'::jsonb
      OR coalesce(payload->>'executionId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR payload->>'decision' NOT IN ('recognized', 'unrecognized', 'other')
      OR (payload ? 'message' AND (jsonb_typeof(payload->'message') IS DISTINCT FROM 'string'
        OR length(payload->>'message') NOT BETWEEN 1 AND 500
        OR payload->>'message' ~ '[[:cntrl:]]')) THEN
      RETURN jsonb_build_object('status', 400, 'error', 'invalid_request');
    END IF;
    -- Feedback belongs to the subject's own emergency access only.
    SELECT EXISTS(
      SELECT FROM execution_private.execution_contexts x
      JOIN execution_private.executions e ON e.tenant_id=x.tenant_id AND e.execution_id=x.execution_id
      WHERE x.tenant_id=tenant AND x.execution_id=(payload->>'executionId')::uuid AND e.issuer=iss
        AND x.emergency
        AND ((x.subject_kind='canonical' AND x.data_subject=sid)
          OR (x.data_subject=who AND (x.subject_kind='login' OR (x.subject_kind IS NULL AND
            (x.consent_id IS NOT NULL OR NOT EXISTS (SELECT FROM app_private.subject_bindings b2
              WHERE b2.tenant_id=tenant AND b2.issuer=iss AND b2.subject_id=who))))))) INTO visible;
    IF NOT visible THEN RETURN jsonb_build_object('status', 404, 'error', 'not_found'); END IF;
    -- Same one-INSERT race as the flag: the loser reads the winning row.
    INSERT INTO app_private.emergency_feedback(tenant_id, execution_id, decision, message, submitted_by, subject_id, issuer)
      VALUES (tenant, (payload->>'executionId')::uuid, payload->>'decision', payload->>'message', who, sid, iss)
      ON CONFLICT DO NOTHING
      RETURNING * INTO feedback;
    IF FOUND THEN
      RETURN jsonb_build_object('status', 201, 'value', jsonb_build_object(
        'executionId', payload->>'executionId',
        'submittedAt', to_char(feedback.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
    END IF;
    SELECT * INTO feedback FROM app_private.emergency_feedback
      WHERE tenant_id=tenant AND execution_id=(payload->>'executionId')::uuid;
    IF NOT FOUND THEN RETURN jsonb_build_object('status', 503, 'error', 'subject_access_unavailable'); END IF;
    IF feedback.decision IS DISTINCT FROM payload->>'decision'
      OR feedback.message IS DISTINCT FROM NULLIF(payload->>'message', '')::text THEN
      RETURN jsonb_build_object('status', 409, 'error', 'resource_conflict',
        'details', jsonb_build_object('submittedAt', to_char(feedback.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
    END IF;
    RETURN jsonb_build_object('status', 200, 'value', jsonb_build_object(
      'executionId', payload->>'executionId',
      'submittedAt', to_char(feedback.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  END IF;

  RETURN jsonb_build_object('status', 400, 'error', 'invalid_operation');
END $$;

REVOKE ALL ON FUNCTION core.subject_access_command(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.subject_access_command(text, jsonb) TO junctura_subject_api;

RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (46);
NOTIFY pgrst, 'reload schema';
COMMIT;
