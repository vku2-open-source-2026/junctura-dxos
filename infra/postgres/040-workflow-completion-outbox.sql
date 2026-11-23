-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'junctura_workflow_worker') THEN
    CREATE ROLE junctura_workflow_worker NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT junctura_workflow_worker TO junctura_data;
GRANT USAGE ON SCHEMA core TO junctura_workflow_worker;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

CREATE TABLE app_private.workflow_task_claims (
  tenant_id text NOT NULL,
  execution_id text NOT NULL,
  task_id text COLLATE "C" NOT NULL,
  holder bytea NOT NULL,
  display_name text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, task_id),
  FOREIGN KEY (tenant_id, execution_id) REFERENCES app_private.workflow_executions (tenant_id, execution_id)
);

CREATE TABLE app_private.workflow_completion_outbox (
  tenant_id text NOT NULL,
  execution_id text NOT NULL,
  definition_id text NOT NULL,
  task_id text COLLATE "C" NOT NULL,
  engine_execution_id text NOT NULL,
  step_key text NOT NULL,
  unit text NOT NULL,
  candidate_group text NOT NULL,
  actor_subject text NOT NULL,
  variables jsonb NOT NULL,
  decision text,
  reason text,
  marker uuid NOT NULL DEFAULT gen_random_uuid(),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'applied', 'cancelled', 'unconfirmed')),
  completed_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease uuid,
  attempts integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, task_id),
  FOREIGN KEY (tenant_id, execution_id) REFERENCES app_private.workflow_executions (tenant_id, execution_id),
  CHECK ((state = 'applied') = (completed_at IS NOT NULL))
);
CREATE INDEX workflow_completion_ready ON app_private.workflow_completion_outbox (available_at) WHERE state = 'pending';
CREATE INDEX workflow_completion_execution ON app_private.workflow_completion_outbox
  (tenant_id, execution_id, state, completed_at DESC, task_id DESC);

ALTER TABLE app_private.workflow_task_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.workflow_task_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app_private.workflow_task_claims TO junctura_app_owner
  USING (tenant_id = app_private.record_tenant());
ALTER TABLE app_private.workflow_completion_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.workflow_completion_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app_private.workflow_completion_outbox TO junctura_app_owner
  USING (tenant_id = app_private.record_tenant());
CREATE POLICY worker_discovery ON app_private.workflow_completion_outbox FOR SELECT TO junctura_app_owner
  USING (current_setting('request.jwt.claims', true)::jsonb->>'role' = 'junctura_workflow_worker');
-- SELECT FOR UPDATE also needs an UPDATE policy. Writes still require tenant scope.
CREATE POLICY worker_row_lock ON app_private.workflow_completion_outbox FOR UPDATE TO junctura_app_owner
  USING (current_setting('request.jwt.claims', true)::jsonb->>'role' = 'junctura_workflow_worker')
  WITH CHECK (tenant_id = app_private.record_tenant());

CREATE FUNCTION app_private.workflow_matching_group(step jsonb) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, app_private, pg_temp AS $$
  SELECT g.unit_group
    FROM jsonb_array_elements_text(step->'groups') WITH ORDINALITY AS candidate(name, position)
    JOIN directory_groups g ON g.tenant_id = record_tenant() AND g.unit = step->>'unit' AND g.unit_group = candidate.name
    JOIN directory_units u ON u.tenant_id = g.tenant_id AND u.unit = g.unit
    WHERE NOT g.pending_delete AND NOT u.pending_delete
      AND current_setting('request.jwt.claims', true)::jsonb->'groups' ? ('/' || g.unit || '/' || g.unit_group)
    ORDER BY candidate.position LIMIT 1
$$;

CREATE FUNCTION core.workflow_task_command(operation text, payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app_private, pg_temp
SET lock_timeout = '2s' SET timezone = 'UTC' AS $$
DECLARE
  tenant text := record_tenant();
  claims jsonb := current_setting('request.jwt.claims', true)::jsonb;
  run workflow_executions;
  claim workflow_task_claims;
  task text := payload->>'taskId';
  execution text := payload->>'executionId';
  step_key text := payload->>'stepKey';
  step jsonb;
  matched_group text;
  holder_scope bytea := record_caller_scope(NULL::uuid);
  actor uuid;
  actor_subject text := claims->>'sub';
  bound_subject text;
  request_scope bytea;
  request_id uuid;
  request_digest bytea;
  completion_path text := '/v1/workflows/executions/' || execution || '/complete';
  replay_only boolean := operation = 'complete' AND NOT (payload ? 'active');
  no_receipt constant jsonb := '{"status":200,"value":null}'::jsonb;
  result jsonb;
  conflict text;
  items jsonb;
  now_at timestamptz := statement_timestamp();
BEGIN
  IF operation = 'list' THEN
    SELECT coalesce(jsonb_agg(view ORDER BY due_at NULLS LAST, task_id), '[]'::jsonb)
      INTO items
      FROM (
        SELECT v.task_id, v.due_at,
          jsonb_build_object('taskId', v.task_id, 'executionId', v.execution_id,
            'definitionKey', v.definition_key, 'stepKey', v.step_key, 'name', v.step->>'name',
            'unit', v.step->>'unit', 'candidateGroups', v.step->'groups', 'dueAt', v.due_at,
            'overdue', coalesce(v.due_at < now_at, false), 'claimedBy', c.display_name,
            'claimedUntil', c.expires_at) AS view
        FROM (
          SELECT t."taskId" COLLATE "C" AS task_id, r.execution_id, r.definition_key,
            t."stepKey" AS step_key, s.step, coalesce((s.step->>'dueAt')::timestamptz, r.due_at) AS due_at
          FROM jsonb_to_recordset(payload->'tasks') AS t("taskId" text, "executionId" text, "definitionId" text, "stepKey" text)
          JOIN workflow_executions r ON r.tenant_id = tenant AND r.execution_id = t."executionId"
            AND r.definition_id = t."definitionId" AND NOT r.cancel_requested
          CROSS JOIN LATERAL (SELECT r.steps->t."stepKey" AS step) s
          WHERE workflow_matching_group(s.step) IS NOT NULL
            AND (payload->>'unit' IS NULL OR s.step->>'unit' = payload->>'unit')
            AND (payload->>'definitionKey' IS NULL OR r.definition_key = payload->>'definitionKey')
            AND (payload->>'candidateGroup' IS NULL OR s.step->'groups' ? (payload->>'candidateGroup'))
            AND NOT EXISTS (SELECT FROM workflow_completion_outbox o WHERE o.tenant_id = tenant AND o.task_id = t."taskId")
        ) v
        LEFT JOIN workflow_task_claims c ON c.tenant_id = tenant AND c.task_id = v.task_id AND c.expires_at > now_at
        WHERE (payload->>'overdue' IS NULL OR (payload->>'overdue')::boolean = coalesce(v.due_at < now_at, false))
          AND (payload->'after' IS NULL OR
            (coalesce(v.due_at, 'infinity'), v.task_id) >
            (coalesce((payload->'after'->>0)::timestamptz, 'infinity'), payload->'after'->>1))
        ORDER BY v.due_at NULLS LAST, v.task_id LIMIT (payload->>'limit')::integer
      ) page;
    RETURN jsonb_build_object('status', 200, 'value', items);
  END IF;

  IF operation = 'history' THEN
    SELECT * INTO run FROM workflow_executions WHERE tenant_id = tenant AND execution_id = execution;
    IF NOT EXISTS (SELECT FROM jsonb_each(run.steps) WHERE workflow_matching_group(value) IS NOT NULL)
      AND (core.workflow_audit_access('{}'::jsonb)->>'status')::int <> 200
    THEN RETURN record_error(403, 'task_group_required'); END IF;
    SELECT coalesce(jsonb_agg(entry ORDER BY completed_at DESC, task_id DESC), '[]'::jsonb) INTO items FROM (
      SELECT completed_at, task_id, jsonb_build_object('taskId', task_id, 'stepKey', o.step_key,
        'unit', o.unit, 'group', candidate_group, 'actorSubject', o.actor_subject,
        'decision', o.decision, 'reason', o.reason, 'completedAt', completed_at) AS entry
      FROM workflow_completion_outbox o WHERE tenant_id = tenant AND execution_id = execution AND state = 'applied'
        AND (payload->'after' IS NULL OR (completed_at, task_id) <
          ((payload->'after'->>0)::timestamptz, payload->'after'->>1))
      ORDER BY completed_at DESC, task_id DESC LIMIT (payload->>'limit')::integer
    ) page;
    RETURN jsonb_build_object('status', 200, 'value', items);
  END IF;

  IF operation NOT IN ('claim','release','complete','cancel') THEN RETURN record_error(400, 'invalid_request'); END IF;
  IF NOT core.resource_writer() THEN RETURN record_error(403, 'write_forbidden'); END IF;
  IF operation = 'cancel' THEN
    SELECT * INTO run FROM workflow_executions WHERE tenant_id = tenant AND execution_id = execution FOR UPDATE;
    IF FOUND THEN
      IF EXISTS (SELECT FROM workflow_completion_outbox o
        WHERE o.tenant_id = tenant AND o.execution_id = execution AND state = 'pending')
      THEN RETURN record_error(409, 'task_conflict'); END IF;
      IF payload->>'status' = 'running' THEN
        UPDATE workflow_executions SET cancel_requested = true WHERE tenant_id = tenant AND execution_id = execution;
      END IF;
    END IF;
    RETURN jsonb_build_object('status', 204);
  END IF;

  IF nullif(claims->>'client_id', '') IS NULL THEN RETURN record_error(403, 'verified_client_required'); END IF;
  SELECT * INTO run FROM workflow_executions WHERE tenant_id = tenant AND execution_id = execution;
  IF replay_only THEN
    SELECT o.step_key INTO step_key FROM workflow_completion_outbox o
      WHERE o.tenant_id = tenant AND o.execution_id = execution AND o.task_id = task;
    IF NOT FOUND THEN RETURN no_receipt; END IF;
  ELSIF NOT FOUND OR run.definition_id <> payload->>'definitionId' OR run.definition_key = 'junctura_checkpoint' THEN
    RETURN record_error(404, 'not_found');
  END IF;
  step := run.steps->step_key;
  matched_group := workflow_matching_group(step);
  IF matched_group IS NULL THEN RETURN record_error(403, 'task_group_required'); END IF;

  IF operation = 'complete' THEN
    actor := record_actor(true);
    bound_subject := core.subject_binding('{}'::jsonb)->'value'->>'subjectId';
    IF payload ? 'records' THEN
      IF actor IS NULL THEN RETURN record_error(403, 'application_access_required'); END IF;
      IF bound_subject IS NULL THEN
        RETURN record_error(403, 'verified_subject_required');
      END IF;
    END IF;
    actor_subject := coalesce(bound_subject, actor_subject);
    request_scope := record_caller_scope(actor);
    request_id := (payload->>'requestKey')::uuid;
    request_digest := decode(payload->>'digest', 'hex');
    result := record_replay(request_scope, 'POST', completion_path, request_id, request_digest);
    IF result IS NOT NULL THEN RETURN result; END IF;
    IF replay_only THEN RETURN no_receipt; END IF;
  END IF;

  -- The execution row coordinates independent tasks with cancellation. Task
  -- claims and outbox state are read only after acquiring that lock.
  SELECT * INTO run FROM workflow_executions WHERE tenant_id = tenant AND execution_id = execution FOR UPDATE;
  now_at := clock_timestamp();
  SELECT * INTO claim FROM workflow_task_claims c
    WHERE c.tenant_id = tenant AND c.task_id = task AND c.expires_at > now_at;
  SELECT CASE o.state WHEN 'applied' THEN 'task_already_completed' ELSE 'task_conflict' END
    INTO conflict FROM workflow_completion_outbox o WHERE o.tenant_id = tenant AND o.task_id = task;

  IF conflict IS NOT NULL THEN
    result := record_error(409, conflict);
  ELSIF NOT (payload->>'active')::boolean OR run.cancel_requested THEN
    result := record_error(409, CASE WHEN (payload->>'finished')::boolean THEN 'task_already_completed' ELSE 'task_conflict' END);
  ELSIF claim.holder IS NOT NULL AND claim.holder <> holder_scope THEN
    result := record_error(409, 'task_claimed',
      jsonb_build_object('claimedBy', claim.display_name, 'claimedUntil', claim.expires_at));
  ELSIF operation = 'claim' THEN
    IF claim.holder IS NULL THEN
      INSERT INTO workflow_task_claims (tenant_id, execution_id, task_id, holder, display_name, expires_at)
      VALUES (tenant, execution, task, holder_scope, coalesce(claims->>'display_name', claims->>'sub'),
        now_at + make_interval(secs => (payload->>'ttlSeconds')::int))
      ON CONFLICT (tenant_id, task_id) DO UPDATE SET holder = excluded.holder,
        display_name = excluded.display_name, expires_at = excluded.expires_at
      RETURNING * INTO claim;
    END IF;
    RETURN jsonb_build_object('status', 200,
      'value', jsonb_build_object('taskId', task, 'claimedBy', claim.display_name, 'claimedUntil', claim.expires_at));
  ELSIF operation = 'release' THEN
    DELETE FROM workflow_task_claims c WHERE c.tenant_id = tenant AND c.task_id = task;
    RETURN jsonb_build_object('status', 204);
  ELSE
    IF payload ? 'records' THEN
      result := record_batch(actor, payload->'records');
      IF result->>'error' = 'schema_violation' THEN
        result := jsonb_set(result, '{details,issues}', (
          SELECT jsonb_agg(jsonb_set(issue, '{path}', to_jsonb('/records' || substr(issue->>'path', 12))) ORDER BY position)
          FROM jsonb_array_elements(result->'details'->'issues') WITH ORDINALITY AS issues(issue, position)));
      END IF;
    END IF;
    IF result IS NULL OR NOT (result ? 'error') THEN
      INSERT INTO workflow_completion_outbox (tenant_id, execution_id, definition_id, task_id,
        engine_execution_id, step_key, unit, candidate_group, actor_subject, variables, decision, reason)
      VALUES (tenant, execution, run.definition_id, task, payload->>'engineExecutionId', step_key,
        step->>'unit', matched_group, actor_subject, payload->'variables',
        payload->'variables'->>'decision', payload->'variables'->>'reason');
      DELETE FROM workflow_task_claims c WHERE c.tenant_id = tenant AND c.task_id = task;
      result := jsonb_build_object('status', 202, 'value', jsonb_build_object('taskId', task,
        'completionStatus', 'pending', 'execution', payload->'execution' || jsonb_build_object('dueAt', run.due_at)));
    END IF;
  END IF;
  IF operation = 'complete' THEN
    PERFORM record_save_replay(request_scope, 'POST', completion_path, request_id, request_digest, result);
  END IF;
  RETURN result;
END $$;

CREATE FUNCTION core.workflow_worker_command(operation text, payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app_private, pg_temp
SET lock_timeout = '2s' SET timezone = 'UTC' AS $$
DECLARE
  job workflow_completion_outbox;
BEGIN
  IF operation = 'lease' THEN
    SELECT * INTO job FROM workflow_completion_outbox WHERE state = 'pending' AND available_at <= clock_timestamp()
      ORDER BY available_at, tenant_id, task_id LIMIT 1 FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN RETURN jsonb_build_object('status', 200, 'value', NULL); END IF;
    PERFORM set_config('request.jwt.claims', jsonb_build_object(
      'role', 'junctura_workflow_worker', 'tenant_id', job.tenant_id)::text, true);
    UPDATE workflow_completion_outbox
      SET lease = gen_random_uuid(), attempts = attempts + 1, available_at = clock_timestamp() + interval '60 seconds'
      WHERE tenant_id = job.tenant_id AND task_id = job.task_id RETURNING * INTO job;
    RETURN jsonb_build_object('status', 200, 'value', to_jsonb(job));
  END IF;
  IF operation = 'settle' AND payload->>'state' IN ('pending', 'applied', 'cancelled', 'unconfirmed') THEN
    UPDATE workflow_completion_outbox SET state = payload->>'state',
      completed_at = (payload->>'completedAt')::timestamptz, lease = NULL,
      available_at = clock_timestamp() + (least(attempts, 12) * interval '5 seconds'),
      variables = CASE WHEN payload->>'state' = 'pending' THEN variables ELSE '{}'::jsonb END
      WHERE tenant_id = record_tenant() AND task_id = payload->>'taskId'
        AND state = 'pending' AND lease = (payload->>'lease')::uuid AND available_at > clock_timestamp();
    RETURN jsonb_build_object('status', 204);
  END IF;
  RETURN record_error(400, 'invalid_request');
END $$;

REVOKE ALL ON FUNCTION app_private.workflow_matching_group(jsonb),
  core.workflow_task_command(text,jsonb), core.workflow_worker_command(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.workflow_task_command(text,jsonb) TO junctura_workflow_api;
GRANT EXECUTE ON FUNCTION core.workflow_worker_command(text,jsonb) TO junctura_workflow_worker;
RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (40);
NOTIFY pgrst, 'reload schema';
COMMIT;
