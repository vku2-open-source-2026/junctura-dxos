-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

ALTER TABLE app_private.workflow_executions
  ADD COLUMN cancel_lease uuid,
  ADD COLUMN cancel_lease_until timestamptz;

CREATE OR REPLACE FUNCTION core.workflow_execution_command(operation text, payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app_private, pg_temp
SET lock_timeout = '2s' SET timezone = 'UTC' AS $$
DECLARE
  tenant text := record_tenant();
  claims jsonb := current_setting('request.jwt.claims', true)::jsonb;
  scope bytea;
  request_id uuid;
  request_digest bytea;
  policy workflow_definition_policies;
  run workflow_executions;
  steps jsonb;
  default_unit text;
  receipt jsonb;
  start_path constant text := '/v1/workflows/executions';
BEGIN
  IF operation = 'get' THEN
    SELECT * INTO run FROM workflow_executions
      WHERE tenant_id = tenant AND execution_id = payload->>'executionId';
    RETURN jsonb_build_object('status', 200, 'value', CASE WHEN FOUND
      THEN jsonb_build_object('dueAt', run.due_at, 'technical', run.definition_key = 'junctura_checkpoint')
      ELSE NULL END);
  END IF;
  IF operation NOT IN ('reserve', 'confirm') THEN RETURN record_error(400, 'invalid_request'); END IF;
  IF NOT core.resource_writer() THEN RETURN record_error(403, 'write_forbidden'); END IF;
  IF nullif(claims->>'client_id', '') IS NULL THEN RETURN record_error(403, 'verified_client_required'); END IF;
  scope := record_caller_scope(NULL::uuid);
  request_id := (payload->>'requestKey')::uuid;
  request_digest := decode(payload->>'digest', 'hex');

  SELECT * INTO run FROM workflow_executions
    WHERE tenant_id = tenant AND caller_scope = scope AND request_key = request_id;

  IF payload->>'definitionKey' <> 'junctura_checkpoint' THEN
    SELECT * INTO policy FROM workflow_definition_policies
      WHERE tenant_id = tenant AND definition_id = payload->>'definitionId' FOR SHARE;
    IF NOT FOUND THEN RETURN record_error(403, 'workflow_unit_required'); END IF;
    default_unit := coalesce(payload->>'unit', policy.default_unit);
    SELECT coalesce(jsonb_object_agg(key, value || jsonb_build_object('unit',
      coalesce(value->>'unit', default_unit))), '{}'::jsonb)
      INTO steps FROM jsonb_each(payload->'steps');

    -- Recheck the original assignments when an operator changes the default unit.
    IF run.digest = request_digest THEN
      steps := run.steps;
      default_unit := run.unit;
    END IF;
    IF EXISTS (
      SELECT FROM (
        SELECT default_unit AS unit UNION SELECT value->>'unit' FROM jsonb_each(steps)
      ) AS needed
      WHERE NOT (needed.unit = ANY(policy.allowed_units)
        AND coalesce(claims->'units' ? needed.unit, false) AND EXISTS (
          SELECT FROM directory_units u WHERE u.tenant_id = tenant AND u.unit = needed.unit AND NOT u.pending_delete
        ))
    ) THEN RETURN record_error(403, 'workflow_unit_required'); END IF;
    IF EXISTS (
      SELECT FROM jsonb_each(steps) AS step,
        LATERAL jsonb_array_elements_text(step.value->'groups') AS candidate(name)
      WHERE NOT EXISTS (
        SELECT FROM directory_groups g WHERE g.tenant_id = tenant AND g.unit = step.value->>'unit'
          AND g.unit_group = candidate.name AND NOT g.pending_delete
      )
    ) THEN RETURN record_error(403, 'workflow_unit_required'); END IF;
  ELSE
    steps := payload->'steps';
  END IF;

  receipt := record_replay(scope, 'POST', start_path, request_id, request_digest);
  IF receipt IS NOT NULL THEN
    IF payload->>'definitionKey' = 'junctura_checkpoint' AND receipt->>'error' = 'idempotency_key_reused' THEN
      RETURN record_error(409, 'idempotency_conflict');
    END IF;
    RETURN receipt;
  END IF;

  -- The receipt lock also serializes creation of the durable reservation.
  SELECT * INTO run FROM workflow_executions
    WHERE tenant_id = tenant AND caller_scope = scope AND request_key = request_id;
  IF FOUND THEN
    IF run.digest <> request_digest THEN
      IF payload->>'definitionKey' = 'junctura_checkpoint' THEN RETURN record_error(409, 'idempotency_conflict'); END IF;
      RETURN record_error(422, 'idempotency_key_reused');
    END IF;
    IF run.start_result IS NOT NULL THEN
      receipt := run.start_result;
    ELSIF operation = 'confirm' AND payload->'execution'->>'definitionId' = run.definition_id THEN
      receipt := jsonb_build_object('status', 201, 'value',
        payload->'execution' || jsonb_build_object('dueAt', run.due_at));
      UPDATE workflow_executions SET execution_id = payload->'execution'->>'id', start_result = receipt
        WHERE tenant_id = tenant AND caller_scope = scope AND request_key = request_id;
      IF run.definition_key = 'junctura_checkpoint' THEN
        UPDATE core.workflow_requests SET engine_id = payload->'execution'->>'id' WHERE tenant_id = tenant AND key = request_id;
      END IF;
    ELSE
      RETURN jsonb_build_object('status', 200, 'value',
        jsonb_build_object('reserved', false, 'businessKey', run.business_key));
    END IF;
    PERFORM record_save_replay(scope, 'POST', start_path, request_id, request_digest, receipt);
    RETURN receipt;
  END IF;

  IF operation <> 'reserve' THEN RETURN record_error(409, 'execution_pending_reconciliation'); END IF;
  IF payload->>'definitionKey' = 'junctura_checkpoint' THEN
    -- Legacy and deadline-aware checkpoint starts share the same durable key.
    INSERT INTO core.workflow_requests (tenant_id, key, definition_id, input_hash)
      VALUES (tenant, request_id, payload->>'definitionId', payload->>'digest')
      ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN RETURN record_error(409, 'idempotency_conflict'); END IF;
  END IF;
  INSERT INTO workflow_executions (tenant_id, caller_scope, request_key, digest,
    definition_id, definition_key, unit, due_at, steps)
  VALUES (tenant, scope, request_id, request_digest, payload->>'definitionId', payload->>'definitionKey',
    default_unit, (payload->>'dueAt')::timestamptz, steps)
  RETURNING * INTO run;
  RETURN jsonb_build_object('status', 200, 'value',
    jsonb_build_object('reserved', true, 'businessKey', run.business_key));
END $$;

CREATE OR REPLACE FUNCTION core.workflow_task_command(operation text, payload jsonb) RETURNS jsonb
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
  cancellation uuid;
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
    -- Core has already checked that the execution exists in this tenant.
    IF NOT FOUND OR run.steps = '{}'::jsonb OR run.definition_key = 'junctura_checkpoint' THEN
      RETURN jsonb_build_object('status', 200, 'value', '[]'::jsonb);
    END IF;
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

  IF operation NOT IN ('claim','release','complete','cancel','resume') THEN RETURN record_error(400, 'invalid_request'); END IF;
  IF NOT core.resource_writer() THEN RETURN record_error(403, 'write_forbidden'); END IF;
  IF operation IN ('cancel', 'resume') THEN
    SELECT * INTO run FROM workflow_executions WHERE tenant_id = tenant AND execution_id = execution FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('status', 204); END IF;

    IF EXISTS (SELECT FROM workflow_completion_outbox o
      WHERE o.tenant_id = tenant AND o.execution_id = execution AND state = 'pending')
    THEN RETURN record_error(409, 'task_conflict'); END IF;

    IF operation = 'resume' THEN
      -- A delayed failure handler cannot release a newer cancellation.
      UPDATE workflow_executions SET cancel_requested = false, cancel_lease = NULL, cancel_lease_until = NULL
        WHERE tenant_id = tenant AND execution_id = execution AND cancel_lease = (payload->>'lease')::uuid;
      RETURN jsonb_build_object('status', 204);
    END IF;

    IF payload->>'status' IS DISTINCT FROM 'running' THEN RETURN jsonb_build_object('status', 204); END IF;
    IF run.cancel_lease_until > clock_timestamp() THEN RETURN record_error(409, 'task_conflict'); END IF;

    cancellation := gen_random_uuid();
    UPDATE workflow_executions
      SET cancel_requested = true, cancel_lease = cancellation, cancel_lease_until = clock_timestamp() + interval '60 seconds'
      WHERE tenant_id = tenant AND execution_id = execution;
    RETURN jsonb_build_object('status', 200, 'value', cancellation);
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

RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (41);
NOTIFY pgrst, 'reload schema';
COMMIT;
