-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'junctura_workflow_api') THEN
    CREATE ROLE junctura_workflow_api NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT junctura_workflow_api TO junctura_data;
GRANT USAGE ON SCHEMA core TO junctura_workflow_api;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
GRANT SELECT, INSERT, UPDATE ON core.workflow_requests TO junctura_app_owner;
CREATE POLICY workflow_checkpoint_reservation ON core.workflow_requests TO junctura_app_owner
  USING (tenant_id = app_private.record_tenant());
SET LOCAL ROLE junctura_app_owner;

-- Written by operators for the exact tenant and deployed definition version.
CREATE TABLE app_private.workflow_definition_policies (
  tenant_id text NOT NULL,
  definition_id text NOT NULL CHECK (definition_id ~ '^[A-Za-z0-9:_-]{1,128}$'),
  default_unit text NOT NULL,
  allowed_units text[] NOT NULL,
  PRIMARY KEY (tenant_id, definition_id),
  FOREIGN KEY (tenant_id, default_unit) REFERENCES app_private.directory_units (tenant_id, unit),
  CHECK (array_position(allowed_units, NULL) IS NULL AND default_unit = ANY(allowed_units))
);

-- The reservation survives the 24-hour HTTP receipt and fixes the policy for
-- this execution even when operators later deploy a new version or edit a binding.
CREATE TABLE app_private.workflow_executions (
  tenant_id text NOT NULL,
  caller_scope bytea NOT NULL,
  request_key uuid NOT NULL,
  digest bytea NOT NULL,
  business_key uuid NOT NULL DEFAULT gen_random_uuid(),
  definition_id text NOT NULL,
  definition_key text NOT NULL,
  unit text,
  due_at timestamptz,
  steps jsonb NOT NULL,
  execution_id text,
  start_result jsonb,
  cancel_requested boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, caller_scope, request_key),
  UNIQUE (tenant_id, execution_id),
  CHECK ((execution_id IS NULL) = (start_result IS NULL))
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['workflow_definition_policies','workflow_executions'] LOOP
    EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app_private.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON app_private.%I TO junctura_app_owner USING (tenant_id=app_private.record_tenant())', t);
  END LOOP;
END $$;

CREATE FUNCTION core.workflow_execution_command(operation text, payload jsonb) RETURNS jsonb
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
  IF receipt IS NOT NULL THEN RETURN receipt; END IF;

  -- The receipt lock also serializes creation of the durable reservation.
  SELECT * INTO run FROM workflow_executions
    WHERE tenant_id = tenant AND caller_scope = scope AND request_key = request_id;
  IF FOUND THEN
    IF run.digest <> request_digest THEN RETURN record_error(422, 'idempotency_key_reused'); END IF;
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
    IF NOT FOUND THEN RETURN record_error(422, 'idempotency_key_reused'); END IF;
  END IF;
  INSERT INTO workflow_executions (tenant_id, caller_scope, request_key, digest,
    definition_id, definition_key, unit, due_at, steps)
  VALUES (tenant, scope, request_id, request_digest, payload->>'definitionId', payload->>'definitionKey',
    default_unit, (payload->>'dueAt')::timestamptz, steps)
  RETURNING * INTO run;
  RETURN jsonb_build_object('status', 200, 'value',
    jsonb_build_object('reserved', true, 'businessKey', run.business_key));
END $$;

REVOKE ALL ON FUNCTION core.workflow_execution_command(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.workflow_execution_command(text,jsonb) TO junctura_workflow_api;
RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (39);
NOTIFY pgrst, 'reload schema';
COMMIT;
