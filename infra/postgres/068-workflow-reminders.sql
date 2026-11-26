-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;

GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

DO $$
DECLARE
  definition text := pg_get_functiondef('core.workflow_execution_command(text,jsonb)'::regprocedure);
  prior text := 'AND coalesce(claims->''units'' ? needed.unit, false) AND EXISTS (';
BEGIN
  IF strpos(definition, prior) = 0 THEN RAISE EXCEPTION 'workflow routing predicate changed'; END IF;
  EXECUTE replace(definition, prior, 'AND (coalesce(claims->''units'' ? needed.unit, false)
          OR (needed.unit <> default_unit AND claims->''units'' ? default_unit
              AND claims->''workflow_router'' = ''true''::jsonb)) AND EXISTS (');
END $$;

ALTER TABLE app_private.workflow_executions
  ADD COLUMN deadline_revision bigint NOT NULL DEFAULT 1;
CREATE FUNCTION app_private.workflow_deadline_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF (NEW.due_at,NEW.steps) IS DISTINCT FROM (OLD.due_at,OLD.steps) THEN
    NEW.deadline_revision := OLD.deadline_revision + 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_deadline_revision BEFORE UPDATE OF due_at,steps ON app_private.workflow_executions
  FOR EACH ROW EXECUTE FUNCTION app_private.workflow_deadline_revision();

CREATE TABLE app_private.workflow_reminders (
  tenant_id text NOT NULL,
  execution_id text NOT NULL,
  task_id text NOT NULL,
  deadline_revision bigint NOT NULL,
  milestone text NOT NULL CHECK (milestone IN ('due_soon','overdue')),
  PRIMARY KEY (tenant_id,task_id,deadline_revision,milestone),
  FOREIGN KEY (tenant_id,execution_id) REFERENCES app_private.workflow_executions (tenant_id,execution_id)
    ON DELETE CASCADE
);
ALTER TABLE app_private.workflow_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.workflow_reminders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app_private.workflow_reminders TO junctura_app_owner
  USING (tenant_id=app_private.record_tenant());

ALTER TABLE app_private.event_notifications DROP CONSTRAINT event_notifications_event_check;
ALTER TABLE app_private.event_notifications ADD CHECK (event IN (
  'record.status.changed','consent.revoked','workflow.task.created','workflow.task.due_soon','workflow.task.overdue'
));

CREATE FUNCTION app_private.workflow_reminder_current(p_target jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,app_private,pg_temp AS $$
  SELECT jsonb_build_object('revision',r.deadline_revision::text,
    'dueAt',coalesce((r.steps->(p_target->>'stepKey')->>'dueAt')::timestamptz,r.due_at),
    'step',r.steps->(p_target->>'stepKey'))
  FROM workflow_executions r
  WHERE r.tenant_id=record_tenant() AND r.execution_id=p_target->>'executionId'
    AND r.definition_id=p_target->>'definitionId' AND r.steps ? (p_target->>'stepKey')
    AND NOT r.cancel_requested AND NOT EXISTS (
      SELECT FROM workflow_completion_outbox o WHERE o.tenant_id=r.tenant_id
        AND o.task_id=p_target->>'taskId' AND o.state IN ('pending','applied','cancelled')
    )
$$;

CREATE FUNCTION core.event_remind_tasks(payload jsonb, lead_seconds integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private,pg_temp
SET timezone='UTC' AS $$
DECLARE
  tenant text := record_tenant();
  observed_at timestamptz := statement_timestamp();
  task jsonb;
  deadline jsonb;
  due timestamptz;
  milestone text;
BEGIN
  IF jsonb_typeof(payload) IS DISTINCT FROM 'array' OR lead_seconds IS NULL OR lead_seconds NOT BETWEEN 1 AND 604800
    THEN RETURN record_error(400,'invalid_request'); END IF;
  IF jsonb_array_length(payload)>100 THEN RETURN record_error(400,'invalid_request'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('junctura.event_observer:' || tenant,0));
  FOR task IN SELECT value FROM jsonb_array_elements(payload) LOOP
    IF coalesce(task->>'taskId','') !~ '^[A-Za-z0-9:_-]{1,128}$' THEN CONTINUE; END IF;
    deadline := workflow_reminder_current(task);
    due := (deadline->>'dueAt')::timestamptz;
    IF due IS NULL OR due>observed_at+make_interval(secs=>lead_seconds) THEN CONTINUE; END IF;
    milestone := CASE WHEN due<=observed_at THEN 'overdue' ELSE 'due_soon' END;
    INSERT INTO workflow_reminders(tenant_id,execution_id,task_id,deadline_revision,milestone)
      VALUES(tenant,task->>'executionId',task->>'taskId',(deadline->>'revision')::bigint,milestone)
      ON CONFLICT DO NOTHING;
    IF FOUND THEN
      PERFORM event_publish('workflow.task.' || milestone,task ||
        jsonb_build_object('deadlineRevision',deadline->>'revision','dueAt',due));
    END IF;
  END LOOP;
  RETURN jsonb_build_object('status',204);
END $$;

CREATE FUNCTION app_private.workflow_reminder_delivery(p_target jsonb, p_event text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,app_private,pg_temp AS $$
  SELECT jsonb_build_object('taskId',p_target->>'taskId','executionId',p_target->>'executionId',
    'dueAt',d.value->'dueAt')
  FROM (SELECT workflow_reminder_current(p_target) AS value) d
  WHERE d.value->>'revision'=p_target->>'deadlineRevision'
    AND (d.value->>'dueAt')::timestamptz=(p_target->>'dueAt')::timestamptz
    AND (p_event='workflow.task.overdue' OR (d.value->>'dueAt')::timestamptz>statement_timestamp())
    AND workflow_matching_group(d.value->'step') IS NOT NULL
$$;

DO $$
DECLARE
  definition text := pg_get_functiondef('core.event_stream_command(text,jsonb)'::regprocedure);
  prior text := 'WHEN notification.event=''workflow.task.created''';
  delivery text := 'WHEN ''workflow.task.created'' THEN';
BEGIN
  IF strpos(definition, prior) = 0 OR strpos(definition, delivery) = 0 THEN
    RAISE EXCEPTION 'workflow journal branches changed';
  END IF;
  definition := replace(definition, prior, 'WHEN notification.event LIKE ''workflow.task.%''');
  EXECUTE replace(definition, delivery, $body$WHEN 'workflow.task.due_soon', 'workflow.task.overdue' THEN
          result := workflow_reminder_delivery(target,notification.event);
        WHEN 'workflow.task.created' THEN$body$);
END $$;

REVOKE ALL ON FUNCTION app_private.workflow_deadline_revision(),app_private.workflow_reminder_current(jsonb),
  app_private.workflow_reminder_delivery(jsonb,text),core.event_remind_tasks(jsonb,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.event_remind_tasks(jsonb,integer) TO junctura_event_observer;
RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (68);
NOTIFY pgrst,'reload schema';
COMMIT;
