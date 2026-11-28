-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
-- Operator-configured delegated business workflow starts and reads. Direct
-- tenant workflow behavior and definition publication remain unchanged.
BEGIN;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

-- One explicit operator row authorizes one (tenant, application client,
-- deployed definition version, verified sender unit). The sender group and all
-- routed units must still exist, be confirmed and not be pending deletion when
-- a start or read is evaluated.
CREATE TABLE app_private.workflow_delegated_policies (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z][a-z0-9-]{0,62}$'),
  app_id uuid NOT NULL,
  oauth_client_id text NOT NULL,
  definition_id text NOT NULL CHECK (definition_id ~ '^[A-Za-z0-9:_-]{1,128}$'),
  sender_unit text NOT NULL CHECK (sender_unit ~ '^[a-z][a-z0-9-]{1,63}$'),
  sender_group text NOT NULL CHECK (sender_group ~ '^[a-z][a-z0-9-]{1,63}$'),
  default_unit text NOT NULL CHECK (default_unit ~ '^[a-z][a-z0-9-]{1,63}$'),
  allowed_units text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, app_id, definition_id, sender_unit),
  FOREIGN KEY (tenant_id, app_id) REFERENCES app_private.applications (tenant_id, app_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, sender_unit) REFERENCES app_private.directory_units (tenant_id, unit),
  FOREIGN KEY (tenant_id, default_unit) REFERENCES app_private.directory_units (tenant_id, unit),
  CHECK (array_position(allowed_units, NULL) IS NULL),
  CHECK (default_unit = ANY(allowed_units)),
  CHECK (sender_unit = ANY(allowed_units))
);
ALTER TABLE app_private.workflow_delegated_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.workflow_delegated_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app_private.workflow_delegated_policies TO junctura_app_owner
  USING (tenant_id = app_private.record_tenant())
  WITH CHECK (tenant_id = app_private.record_tenant());
REVOKE ALL ON app_private.workflow_delegated_policies FROM PUBLIC;

-- Delegated ownership is captured once from the verified exchange and start
-- authorization. Direct and legacy rows keep these columns NULL and therefore
-- never satisfy a delegated read.
ALTER TABLE app_private.workflow_executions
  ADD COLUMN delegated_app_id uuid,
  ADD COLUMN delegated_client_id text,
  ADD COLUMN sender_unit text,
  ADD COLUMN sender_group text,
  ADD COLUMN sender_subject text;
ALTER TABLE app_private.workflow_executions
  ADD CHECK ((delegated_app_id IS NULL) = (delegated_client_id IS NULL)
    AND (delegated_app_id IS NULL) = (sender_unit IS NULL)
    AND (delegated_app_id IS NULL) = (sender_group IS NULL)
    AND (delegated_app_id IS NULL) = (sender_subject IS NULL));

-- The per-request authorizer supplies the exact trusted app ID and selected
-- unit. Re-prove that app/enrollment is active and belongs to the signed client
-- and actor; never select an app by a broader tenant/client join.
CREATE FUNCTION app_private.workflow_delegated_app() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, app_private AS $$
  SELECT a.app_id
  FROM applications a JOIN enrollments e
    ON (e.tenant_id,e.issuer,e.oauth_client_id,e.owner_subject,e.provider_origin)=
       (a.tenant_id,a.issuer,a.oauth_client_id,a.owner_subject,a.provider_origin)
  CROSS JOIN (SELECT current_setting('request.jwt.claims',true)::jsonb AS c) claims
  WHERE a.tenant_id=claims.c->>'tenant_id'
    AND a.app_id::text=claims.c->>'app_id'
    AND a.issuer=claims.c->>'iss'
    AND a.oauth_client_id=claims.c->>'client_id'
    AND e.resource_subject=claims.c->>'actor_sub'
    AND claims.c->>'sub' IS DISTINCT FROM claims.c->>'actor_sub'
    AND e.enabled AND a.state='active' AND cardinality(a.deployment_units)>0
$$;

-- A delegated request key is scoped to the trusted app/client, actor, sender
-- subject and selected unit. It can never collide with a direct caller scope.
CREATE FUNCTION app_private.workflow_delegated_scope() RETURNS bytea
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT sha256(convert_to(jsonb_build_array('junctura-workflow-delegated/1',
    c->>'iss',c->>'app_id',c->>'client_id',c->>'actor_sub',c->>'sub',c->>'app_unit')::text,'UTF8'))
  FROM (SELECT current_setting('request.jwt.claims',true)::jsonb AS c) claims
$$;

-- Current Directory membership and the verified token path must agree.
CREATE FUNCTION app_private.workflow_delegated_group_member(p_unit text, p_group text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, app_private, pg_temp AS $$
  SELECT coalesce((current_setting('request.jwt.claims',true)::jsonb)->'groups'
      ? ('/' || p_unit || '/' || p_group), false) AND EXISTS (
    SELECT FROM directory_groups g
    JOIN directory_members m ON (m.tenant_id,m.unit,m.subject)=
      (g.tenant_id,g.unit,current_setting('request.jwt.claims',true)::jsonb->>'sub')
    JOIN directory_memberships ms
      ON (ms.tenant_id,ms.unit,ms.subject,ms.unit_group)=(g.tenant_id,g.unit,m.subject,g.unit_group)
    WHERE g.tenant_id=current_setting('request.jwt.claims',true)::jsonb->>'tenant_id'
      AND g.unit=p_unit AND g.unit_group=p_group
      AND NOT g.pending_delete AND g.confirmed_value IS NOT NULL
      AND NOT m.pending_delete AND m.confirmed_value IS NOT NULL
      AND (m.confirmed_value->'groups') ? p_group
  )
$$;

-- The exchange assignment must still be active and synchronized in this unit.
CREATE FUNCTION app_private.workflow_delegated_assigned(p_app uuid, p_unit text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, app_private, pg_temp AS $$
  SELECT EXISTS (
    SELECT FROM app_assignments s
    JOIN applications a ON (a.tenant_id,a.app_id)=(s.tenant_id,s.app_id)
    JOIN directory_units u ON (u.tenant_id,u.unit)=(s.tenant_id,s.unit)
    JOIN directory_members m ON (m.tenant_id,m.unit,m.subject)=
      (s.tenant_id,s.unit,current_setting('request.jwt.claims',true)::jsonb->>'sub')
    WHERE s.tenant_id=current_setting('request.jwt.claims',true)::jsonb->>'tenant_id'
      AND s.app_id=p_app AND s.unit=p_unit
      AND s.enabled AND s.synchronized AND s.unit=ANY(a.deployment_units) AND a.state='active'
      AND ((current_setting('request.jwt.claims',true)::jsonb)->'client_roles')
        ? ('junctura-assignment-'||s.assignment_id)
      AND NOT u.pending_delete AND u.confirmed_value IS NOT NULL
      AND NOT m.pending_delete AND m.confirmed_value IS NOT NULL
      AND (s.target_type='unit'
        OR s.target_type='subject'
          AND s.target=current_setting('request.jwt.claims',true)::jsonb->>'sub'
        OR s.target_type='group' AND (m.confirmed_value->'groups') ? s.target AND EXISTS (
          SELECT FROM directory_memberships g
          WHERE (g.tenant_id,g.unit,g.subject,g.unit_group)=(s.tenant_id,s.unit,m.subject,s.target)))
  )
$$;

-- A current reader must be the initiating sender group in the sender unit, or
-- a member of a candidate group routed to the caller's currently selected unit.
CREATE FUNCTION app_private.workflow_delegated_participant(p_run app_private.workflow_executions)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path = pg_catalog, app_private, pg_temp AS $$
DECLARE
  c jsonb := current_setting('request.jwt.claims',true)::jsonb;
  actor uuid := workflow_delegated_app();
  selected_unit text := c->>'app_unit';
BEGIN
  IF actor IS NULL OR p_run.delegated_app_id IS DISTINCT FROM actor
      OR p_run.delegated_client_id IS DISTINCT FROM c->>'client_id'
      OR selected_unit IS NULL OR NOT (c->'units' ? selected_unit)
      OR NOT workflow_delegated_assigned(actor,selected_unit) THEN
    RETURN false;
  END IF;
  IF selected_unit=p_run.sender_unit
      AND p_run.sender_subject IS NOT DISTINCT FROM c->>'sub'
      AND workflow_delegated_group_member(selected_unit,p_run.sender_group) THEN
    RETURN true;
  END IF;
  RETURN EXISTS (
    SELECT FROM jsonb_each(p_run.steps) AS step,
      LATERAL jsonb_array_elements_text(coalesce(step.value->'groups','[]'::jsonb)) AS candidate(name)
    WHERE step.value->>'unit'=selected_unit
      AND workflow_delegated_group_member(selected_unit,candidate.name)
  );
END $$;

-- Replays and confirmations must still satisfy the persisted sender ownership,
-- not only the current policy row (which an operator may have edited).
CREATE FUNCTION app_private.workflow_delegated_sender_current(p_run app_private.workflow_executions)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, app_private, pg_temp AS $$
  SELECT workflow_delegated_assigned(p_run.delegated_app_id,p_run.sender_unit)
    AND p_run.sender_subject IS NOT DISTINCT FROM current_setting('request.jwt.claims',true)::jsonb->>'sub'
    AND workflow_delegated_group_member(p_run.sender_unit,p_run.sender_group)
$$;

CREATE FUNCTION core.workflow_delegated_command(operation text, payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app_private, pg_temp
SET lock_timeout = '2s' SET timezone = 'UTC' AS $$
DECLARE
  tenant text := record_tenant();
  claims jsonb := current_setting('request.jwt.claims', true)::jsonb;
  scope bytea;
  request_id uuid;
  request_digest bytea;
  policy workflow_delegated_policies;
  run workflow_executions;
  steps jsonb;
  default_unit text;
  selected_unit text := claims->>'app_unit';
  actor uuid := workflow_delegated_app();
  receipt jsonb;
  items jsonb;
BEGIN
  IF operation IN ('access','history') THEN
    IF jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN RETURN record_error(400,'invalid_request'); END IF;
    SELECT * INTO run FROM workflow_executions
      WHERE tenant_id=tenant AND execution_id=payload->>'executionId';
    IF NOT FOUND OR run.delegated_app_id IS NULL OR NOT workflow_delegated_participant(run) THEN
      RETURN record_error(404,'not_found');
    END IF;
    IF operation='access' THEN
      RETURN jsonb_build_object('status',200,'value',jsonb_build_object(
        'allowed',true,'executionId',run.execution_id,'appId',run.delegated_app_id,
        'senderUnit',run.sender_unit,'senderGroup',run.sender_group,'dueAt',run.due_at));
    END IF;
    IF run.steps = '{}'::jsonb OR run.definition_key = 'junctura_checkpoint' THEN
      RETURN jsonb_build_object('status',200,'value','[]'::jsonb);
    END IF;
    IF payload ? 'after' AND payload->'after' IS DISTINCT FROM 'null'::jsonb
        AND jsonb_typeof(payload->'after') IS DISTINCT FROM 'array' THEN
      RETURN record_error(400,'invalid_request');
    END IF;
    IF coalesce(payload->>'limit','') !~ '^[0-9]{1,3}$'
        OR (payload->>'limit')::integer NOT BETWEEN 1 AND 101 THEN
      RETURN record_error(400,'invalid_request');
    END IF;
    SELECT coalesce(jsonb_agg(entry ORDER BY completed_at DESC, task_id DESC),'[]'::jsonb) INTO items
    FROM (
      SELECT completed_at, task_id, jsonb_build_object('taskId', task_id, 'stepKey', o.step_key,
        'unit', o.unit, 'group', candidate_group, 'actorSubject', o.actor_subject,
        'decision', o.decision, 'reason', o.reason, 'completedAt', completed_at) AS entry
      FROM workflow_completion_outbox o
      WHERE o.tenant_id=tenant AND o.execution_id=payload->>'executionId' AND o.state='applied'
        AND (payload->'after' IS NULL OR payload->'after' = 'null'::jsonb
          OR (completed_at, task_id) <
            ((payload->'after'->>0)::timestamptz, payload->'after'->>1))
      ORDER BY completed_at DESC, task_id DESC LIMIT (payload->>'limit')::integer
    ) page;
    RETURN jsonb_build_object('status',200,'value',items);
  END IF;

  IF operation NOT IN ('reserve','confirm') THEN RETURN record_error(400,'invalid_request'); END IF;
  IF NOT core.resource_writer() THEN RETURN record_error(403,'write_forbidden'); END IF;
  IF nullif(claims->>'client_id','') IS NULL THEN RETURN record_error(403,'verified_client_required'); END IF;
  IF actor IS NULL OR selected_unit IS NULL OR NOT (claims->'units' ? selected_unit) THEN
    RETURN record_error(403,'delegation_not_allowed');
  END IF;
  scope := workflow_delegated_scope();
  request_id := (payload->>'requestKey')::uuid;
  IF scope IS NULL OR request_id IS NULL THEN RETURN record_error(400,'invalid_request'); END IF;
  request_digest := decode(payload->>'digest','hex');
  IF request_digest IS NULL THEN RETURN record_error(400,'invalid_request'); END IF;

  -- The exact operator row is required even for a replay. Retiring the policy or
  -- losing the current sender membership therefore denies further starts.
  SELECT * INTO policy FROM workflow_delegated_policies p
    WHERE p.tenant_id=tenant AND p.app_id=actor AND p.oauth_client_id=claims->>'client_id'
      AND p.definition_id=payload->>'definitionId' AND p.sender_unit=selected_unit FOR SHARE;
  IF NOT FOUND THEN RETURN record_error(403,'workflow_unit_required'); END IF;
  IF NOT workflow_delegated_assigned(actor,policy.sender_unit)
      OR NOT workflow_delegated_group_member(policy.sender_unit,policy.sender_group) THEN
    RETURN record_error(403,'workflow_unit_required');
  END IF;

  -- Serialize the same synthetic key across replicas before reading or creating
  -- the reservation. Only the reserving request may invoke the engine start.
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(
    'workflow-delegated', tenant, encode(scope,'hex'), request_id)::text,0));
  SELECT * INTO run FROM workflow_executions
    WHERE tenant_id=tenant AND caller_scope=scope AND request_key=request_id;
  IF FOUND THEN
    -- The same durable key is bound to the original app and sender unit.
    IF run.delegated_app_id IS DISTINCT FROM actor
        OR run.delegated_client_id IS DISTINCT FROM claims->>'client_id'
        OR run.sender_unit IS DISTINCT FROM selected_unit THEN
      RETURN record_error(404,'not_found');
    END IF;
    IF NOT workflow_delegated_sender_current(run) THEN
      RETURN record_error(403,'workflow_unit_required');
    END IF;
    IF run.digest <> request_digest THEN RETURN record_error(422,'idempotency_key_reused'); END IF;
    IF run.start_result IS NOT NULL THEN
      receipt := run.start_result;
    ELSIF operation='confirm' AND payload->'execution'->>'definitionId'=run.definition_id THEN
      receipt := jsonb_build_object('status',201,'value',
        payload->'execution' || jsonb_build_object('dueAt',run.due_at));
      UPDATE workflow_executions SET execution_id=payload->'execution'->>'id', start_result=receipt
        WHERE tenant_id=tenant AND caller_scope=scope AND request_key=request_id;
    ELSE
      RETURN jsonb_build_object('status',200,'value',
        jsonb_build_object('reserved',false,'businessKey',run.business_key));
    END IF;
    RETURN receipt;
  END IF;
  IF operation <> 'reserve' THEN RETURN record_error(409,'execution_pending_reconciliation'); END IF;

  default_unit := coalesce(payload->>'unit', policy.default_unit);
  SELECT coalesce(jsonb_object_agg(key, value || jsonb_build_object('unit',
    coalesce(value->>'unit', default_unit))), '{}'::jsonb)
    INTO steps FROM jsonb_each(payload->'steps');
  IF EXISTS (
    SELECT FROM (
      SELECT default_unit AS unit UNION SELECT value->>'unit' FROM jsonb_each(steps)
    ) AS needed
    WHERE NOT (needed.unit = ANY(policy.allowed_units)
      AND EXISTS (SELECT FROM applications a WHERE a.tenant_id=tenant AND a.app_id=actor
        AND a.state='active' AND needed.unit=ANY(a.deployment_units))
      AND EXISTS (SELECT FROM directory_units u WHERE u.tenant_id=tenant AND u.unit=needed.unit
        AND NOT u.pending_delete AND u.confirmed_value IS NOT NULL))
  ) THEN RETURN record_error(403,'workflow_unit_required'); END IF;
  IF EXISTS (
    SELECT FROM jsonb_each(steps) AS step,
      LATERAL jsonb_array_elements_text(coalesce(step.value->'groups','[]'::jsonb)) AS candidate(name)
    WHERE NOT EXISTS (
      SELECT FROM directory_groups g WHERE g.tenant_id=tenant AND g.unit=step.value->>'unit'
        AND g.unit_group=candidate.name AND NOT g.pending_delete AND g.confirmed_value IS NOT NULL)
  ) THEN RETURN record_error(403,'workflow_unit_required'); END IF;

  INSERT INTO workflow_executions (tenant_id, caller_scope, request_key, digest,
    definition_id, definition_key, unit, due_at, steps,
    delegated_app_id, delegated_client_id, sender_unit, sender_group, sender_subject)
  VALUES (tenant, scope, request_id, request_digest, payload->>'definitionId', payload->>'definitionKey',
    default_unit, (payload->>'dueAt')::timestamptz, steps,
    actor, claims->>'client_id', selected_unit, policy.sender_group, claims->>'sub')
  ON CONFLICT (tenant_id, caller_scope, request_key) DO NOTHING
  RETURNING * INTO run;
  IF NOT FOUND THEN
    SELECT * INTO run FROM workflow_executions
      WHERE tenant_id=tenant AND caller_scope=scope AND request_key=request_id;
    IF NOT FOUND THEN RETURN record_error(409,'execution_pending_reconciliation'); END IF;
    IF run.delegated_app_id IS DISTINCT FROM actor
        OR run.delegated_client_id IS DISTINCT FROM claims->>'client_id'
        OR run.sender_unit IS DISTINCT FROM selected_unit THEN
      RETURN record_error(404,'not_found');
    END IF;
    IF NOT workflow_delegated_sender_current(run) THEN
      RETURN record_error(403,'workflow_unit_required');
    END IF;
    IF run.digest <> request_digest THEN RETURN record_error(422,'idempotency_key_reused'); END IF;
    IF run.start_result IS NOT NULL THEN RETURN run.start_result; END IF;
    RETURN jsonb_build_object('status', 200, 'value',
      jsonb_build_object('reserved',false,'businessKey',run.business_key));
  END IF;
  RETURN jsonb_build_object('status', 200, 'value',
    jsonb_build_object('reserved', true, 'businessKey', run.business_key));
END $$;

-- The delegated RPC handles its own history operation. The legacy task RPC is
-- intentionally untouched so direct callers and operator audit.read history
-- keep exactly their previous behavior.
REVOKE ALL ON FUNCTION app_private.workflow_delegated_app(),
  app_private.workflow_delegated_scope(),
  app_private.workflow_delegated_group_member(text,text),
  app_private.workflow_delegated_assigned(uuid,text),
  app_private.workflow_delegated_participant(app_private.workflow_executions),
  app_private.workflow_delegated_sender_current(app_private.workflow_executions),
  core.workflow_delegated_command(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.workflow_delegated_command(text,jsonb) TO junctura_workflow_api;

RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (76);
NOTIFY pgrst, 'reload schema';
COMMIT;
