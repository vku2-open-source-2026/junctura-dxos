-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='junctura_event_api') THEN
    CREATE ROLE junctura_event_api NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='junctura_event_observer') THEN
    CREATE ROLE junctura_event_observer NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT junctura_event_api,junctura_event_observer TO junctura_data;
GRANT USAGE ON SCHEMA core TO junctura_event_api,junctura_event_observer;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

CREATE TABLE app_private.event_heads (
  tenant_id text PRIMARY KEY,
  sequence bigint NOT NULL
);
CREATE TABLE app_private.event_notifications (
  tenant_id text NOT NULL,
  sequence bigint NOT NULL,
  event text NOT NULL CHECK (event IN ('record.status.changed','consent.revoked','workflow.task.created')),
  target jsonb NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,sequence)
);
CREATE INDEX event_notifications_age_idx ON app_private.event_notifications (tenant_id,published_at);
CREATE TABLE app_private.event_observed_tasks (
  tenant_id text NOT NULL,
  task_id text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,task_id)
);
CREATE INDEX event_observed_tasks_age_idx ON app_private.event_observed_tasks (tenant_id,created_at);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['event_heads','event_notifications','event_observed_tasks'] LOOP
    EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE app_private.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_isolation ON app_private.%I TO junctura_app_owner
      USING (tenant_id=app_private.record_tenant()) WITH CHECK (tenant_id=app_private.record_tenant())',t);
  END LOOP;
END $$;

CREATE FUNCTION app_private.event_publish(p_event text,p_target jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,app_private,pg_temp AS $$
DECLARE
  tenant text := record_tenant();
  next_seq bigint;
BEGIN
  -- This row lock survives through commit, so readers cannot advance past a
  -- reserved sequence while an earlier publisher is still uncommitted.
  INSERT INTO event_heads AS h(tenant_id,sequence) VALUES(tenant,1)
    ON CONFLICT (tenant_id) DO UPDATE SET sequence=h.sequence+1
    RETURNING sequence INTO next_seq;
  INSERT INTO event_notifications(tenant_id,sequence,event,target) VALUES(tenant,next_seq,p_event,p_target);
  DELETE FROM event_notifications n WHERE n.tenant_id=tenant AND
    (n.sequence<=next_seq-1024 OR n.published_at<=clock_timestamp()-interval '2 minutes');
END $$;

CREATE FUNCTION app_private.event_publish_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private,pg_temp AS $$
DECLARE
  previous text := current_setting('request.jwt.claims',true);
BEGIN
  -- The source row supplies tenant identity, including operator-side writes.
  PERFORM set_config('request.jwt.claims',jsonb_build_object('tenant_id',NEW.tenant_id)::text,true);
  IF TG_TABLE_NAME='app_records' THEN
    PERFORM event_publish('record.status.changed',jsonb_build_object('id',NEW.id,'collection',NEW.collection,
      'ownerAppId',NEW.owner_app_id,'incarnation',NEW.incarnation));
  ELSE
    PERFORM event_publish('consent.revoked',jsonb_build_object('consentId',NEW.consent_id));
  END IF;
  PERFORM set_config('request.jwt.claims',coalesce(previous,''),true);
  RETURN NULL;
END $$;

-- The separate Flowable engine has already committed when the observer sees
-- an active task. Matching the confirmed execution prevents provisional starts
-- from being published, while the unique observation row deduplicates replicas.
CREATE FUNCTION core.event_observe_tasks(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private,pg_temp AS $$
DECLARE
  tenant text := record_tenant();
  cutoff timestamptz := clock_timestamp()-interval '2 minutes';
  task jsonb;
  created timestamptz;
BEGIN
  IF jsonb_typeof(payload) IS DISTINCT FROM 'array' THEN RETURN record_error(400,'invalid_request'); END IF;
  IF jsonb_array_length(payload)>400 THEN RETURN record_error(400,'invalid_request'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('junctura.event_observer:' || tenant,0));
  DELETE FROM event_observed_tasks WHERE tenant_id=tenant AND created_at<=cutoff;
  FOR task IN SELECT value FROM jsonb_array_elements(payload) LOOP
    created:=record_time('date-time',task->>'createdAt');
    IF created IS NULL OR created<=cutoff OR created>clock_timestamp()+interval '5 seconds'
      OR coalesce(task->>'taskId','') !~ '^[A-Za-z0-9:_-]{1,128}$'
      OR NOT EXISTS (SELECT FROM workflow_executions r WHERE r.tenant_id=tenant
        AND r.execution_id=task->>'executionId' AND r.definition_id=task->>'definitionId'
        AND r.steps ? (task->>'stepKey') AND NOT r.cancel_requested) THEN
      CONTINUE;
    END IF;
    INSERT INTO event_observed_tasks(tenant_id,task_id,created_at) VALUES(tenant,task->>'taskId',created)
      ON CONFLICT DO NOTHING;
    IF FOUND THEN PERFORM event_publish('workflow.task.created',task); END IF;
  END LOOP;
  RETURN jsonb_build_object('status',204);
END $$;

CREATE FUNCTION core.event_stream_command(operation text,payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private,pg_temp
SET timezone='UTC' AS $$
DECLARE
  tenant text := record_tenant();
  c jsonb := current_setting('request.jwt.claims',true)::jsonb;
  after_seq bigint := coalesce((payload->>'after')::bigint,0);
  notification event_notifications;
  target jsonb;
  result jsonb;
BEGIN
  IF operation='start' THEN
    SELECT jsonb_build_object('sequence',coalesce(h.sequence,0)::text,'startedAt',statement_timestamp())
      INTO result FROM (SELECT 1) seed LEFT JOIN event_heads h ON h.tenant_id=tenant;
  ELSIF operation='poll' THEN
    WITH head AS (
      SELECT coalesce((SELECT sequence FROM event_heads WHERE tenant_id=tenant),0) AS sequence
    ), page AS (
      SELECT n.sequence,n.event,n.target FROM event_notifications n CROSS JOIN head h
      WHERE n.tenant_id=tenant AND n.sequence>after_seq AND h.sequence-after_seq BETWEEN 0 AND 64
        AND n.published_at>statement_timestamp()-interval '2 minutes' ORDER BY n.sequence LIMIT 64
    )
    SELECT jsonb_build_object('overflow',h.sequence-after_seq<>count(p.sequence),
      'items',coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('sequence',p.sequence::text,'event',p.event,
        'task',CASE WHEN p.event='workflow.task.created' THEN p.target END)) ORDER BY p.sequence)
        FILTER (WHERE p.sequence IS NOT NULL),'[]'::jsonb))
    INTO result FROM head h LEFT JOIN page p ON true GROUP BY h.sequence;
  ELSIF operation='deliver' THEN
    SELECT * INTO notification FROM event_notifications n
    WHERE n.tenant_id=tenant AND n.sequence=(payload->>'sequence')::bigint
      AND n.published_at>statement_timestamp()-interval '2 minutes';
    IF FOUND THEN
      target:=notification.target;
      CASE notification.event
        WHEN 'record.status.changed' THEN
          SELECT jsonb_build_object('recordRef',jsonb_build_object('id',r.id,'collection',r.collection)) INTO result
          FROM core.app_records r WHERE r.tenant_id=tenant AND r.id=(target->>'id')::uuid
            AND r.owner_app_id=(target->>'ownerAppId')::uuid AND r.collection=target->>'collection'
            AND r.incarnation=(target->>'incarnation')::uuid AND record_read_scope(r.owner_app_id,r.id) IS NOT NULL;
        WHEN 'consent.revoked' THEN
          SELECT jsonb_build_object('consentId',s.consent_id) INTO result
          FROM execution_private.subject_consents s WHERE s.tenant_id=tenant AND s.consent_id=(target->>'consentId')::uuid
            AND s.revoked_at IS NOT NULL AND s.issuer=c->>'iss' AND (
              s.consumer_app_id=core.resource_actor() OR
              (s.data_subject=c->>'sub' AND (s.canonical_subject IS NULL OR EXISTS (
                SELECT FROM subject_bindings b WHERE b.tenant_id=tenant AND b.issuer=s.issuer AND b.login_subject=c->>'sub'
                  AND b.subject_id=s.canonical_subject AND b.subject_id=c->>'subject_id'
              )))
            );
        WHEN 'workflow.task.created' THEN
          SELECT jsonb_build_object('taskId',target->>'taskId','executionId',r.execution_id) INTO result
          FROM workflow_executions r WHERE r.tenant_id=tenant AND r.execution_id=target->>'executionId'
            AND r.definition_id=target->>'definitionId' AND NOT r.cancel_requested
            AND workflow_matching_group(r.steps->(target->>'stepKey')) IS NOT NULL;
      END CASE;
    END IF;
  ELSE RETURN record_error(400,'invalid_request');
  END IF;
  RETURN jsonb_build_object('status',200,'value',result);
END $$;

REVOKE ALL ON FUNCTION app_private.event_publish(text,jsonb),app_private.event_publish_row(),
  core.event_stream_command(text,jsonb),core.event_observe_tasks(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.event_stream_command(text,jsonb) TO junctura_event_api;
GRANT EXECUTE ON FUNCTION core.event_observe_tasks(jsonb) TO junctura_event_observer;
RESET ROLE;

-- Defer notification sequencing until the source transaction reaches commit.
CREATE CONSTRAINT TRIGGER notify_record_status_on_insert AFTER INSERT ON core.app_records
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.data ? 'status')
  EXECUTE FUNCTION app_private.event_publish_row();
CREATE CONSTRAINT TRIGGER notify_record_status_on_update AFTER UPDATE ON core.app_records
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((OLD.data->'status') IS DISTINCT FROM (NEW.data->'status'))
  EXECUTE FUNCTION app_private.event_publish_row();
CREATE CONSTRAINT TRIGGER notify_consent_revoked AFTER UPDATE ON execution_private.subject_consents
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
  EXECUTE FUNCTION app_private.event_publish_row();

REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (45);
NOTIFY pgrst,'reload schema';
COMMIT;
