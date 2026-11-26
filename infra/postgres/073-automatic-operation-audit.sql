-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

CREATE FUNCTION app_private.audit_operation(p_event text,p_resource uuid,p_request text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,app_private,pg_temp AS $$
BEGIN
  PERFORM audit_append(p_event,'audit',p_resource,0,'success',NULL,
    CASE WHEN p_request ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN p_request END);
END $$;

ALTER TABLE app_private.workflow_completion_outbox ADD COLUMN audit_actor jsonb;
CREATE FUNCTION app_private.audit_workflow_applied() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,app_private,pg_temp AS $$
DECLARE previous text:=current_setting('request.jwt.claims',true);
BEGIN
  PERFORM set_config('request.jwt.claims',NEW.audit_actor::text,true);
  PERFORM audit_operation('audit.workflow_completed',NEW.marker,NEW.audit_actor->>'request_id');
  PERFORM set_config('request.jwt.claims',coalesce(previous,''),true);
  RETURN NULL;
END $$;
CREATE TRIGGER audit_workflow_applied AFTER UPDATE ON app_private.workflow_completion_outbox
  FOR EACH ROW WHEN (NEW.state='applied' AND OLD.state<>'applied' AND NEW.audit_actor IS NOT NULL)
  EXECUTE FUNCTION app_private.audit_workflow_applied();

DO $$
DECLARE change record; definition text;
BEGIN
  FOR change IN SELECT * FROM (VALUES
    ('core.workflow_task_command(text,jsonb)',
      $old$engine_execution_id, step_key, unit, candidate_group, actor_subject, variables, decision, reason)$old$,
      $new$engine_execution_id, step_key, unit, candidate_group, actor_subject, variables, decision, reason, audit_actor)$new$),
    ('core.workflow_task_command(text,jsonb)',
      $old$payload->'variables'->>'decision', payload->'variables'->>'reason');$old$,
      $new$payload->'variables'->>'decision', payload->'variables'->>'reason',
        jsonb_build_object('tenant_id',tenant,'iss',claims->>'iss','sub',claims->>'sub',
          'client_id',claims->>'client_id','request_id',payload->>'requestId'));$new$),
    ('core.record_command(text,jsonb)', $old$result := record_apply(operation, actor, payload);$old$,
      $new$result := record_apply(operation, actor, payload);
  IF NOT (result ? 'error') AND operation IN ('batch','register') THEN
    PERFORM audit_operation(CASE operation WHEN 'batch' THEN 'audit.record_batch' ELSE 'audit.record_schema_registered' END,
      actor,claims->>'request_id');
  END IF;$new$),
    ('app_private.record_mask_policy(uuid,text,jsonb)',
      $old$AND field_masking IS DISTINCT FROM p_fields;$old$,
      $new$AND field_masking IS DISTINCT FROM p_fields;
    IF FOUND THEN
      PERFORM audit_operation('audit.record_masking_changed',p_actor,current_setting('request.jwt.claims',true)::jsonb->>'request_id');
    END IF;$new$),
    ('core.record_archive(text,jsonb)', $old$result := record_import(actor, payload->'records');$old$,
      $new$result := record_import(actor, payload->'records');
    IF NOT (result ? 'error') THEN PERFORM audit_operation('audit.records_imported',actor,claims->>'request_id'); END IF;$new$),
    ('core.record_archive(text,jsonb)',
      $old$RETURN record_export_end((payload->>'snapshotId')::uuid, record_caller_scope(actor));$old$,
      $new$IF payload->'completed' = 'true'::jsonb THEN
      PERFORM FROM record_export_snapshots s WHERE s.tenant_id=record_tenant()
        AND s.snapshot_id=(payload->>'snapshotId')::uuid AND s.caller_scope=record_caller_scope(actor)
        AND s.expires_at>clock_timestamp() FOR UPDATE;
      IF FOUND THEN PERFORM audit_operation('audit.records_exported',(payload->>'snapshotId')::uuid,claims->>'request_id'); END IF;
    END IF;
    RETURN record_export_end((payload->>'snapshotId')::uuid, record_caller_scope(actor));$new$)
  ) AS v(signature,old_text,new_text) LOOP
    definition:=pg_get_functiondef(change.signature::regprocedure);
    IF (length(definition)-length(replace(definition,change.old_text,'')))<>length(change.old_text)
      THEN RAISE EXCEPTION 'Unexpected automatic audit anchor for %',change.signature; END IF;
    EXECUTE replace(definition,change.old_text,change.new_text);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION app_private.audit_operation(text,uuid,text),app_private.audit_workflow_applied() FROM PUBLIC;
RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (73);
NOTIFY pgrst,'reload schema';
COMMIT;
