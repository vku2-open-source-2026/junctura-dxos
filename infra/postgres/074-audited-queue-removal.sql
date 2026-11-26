-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;
DO $$
DECLARE
  definition text:=pg_get_functiondef('core.queue_command(text,text,jsonb)'::regprocedure);
  allowed text:='''configure'', ''send'', ''lease'', ''ack'', ''nack'', ''list'', ''replay''';
  branch text:='  IF operation = ''configure'' THEN';
  successful text:='coalesce(msg.attempts, 0), ''success'', reason);';
BEGIN
  IF strpos(definition,allowed)=0 OR strpos(definition,branch)=0 OR strpos(definition,successful)=0
    THEN RAISE EXCEPTION 'Unexpected queue removal audit anchor'; END IF;
  definition:=replace(definition,allowed,allowed || ',''delete''');
  definition:=replace(definition,successful,
    $body$coalesce(msg.attempts, 0), 'success', reason, request_id::text);$body$);
  EXECUTE replace(definition,branch,$body$  IF operation='delete' THEN
    IF coalesce(payload->>'key','') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
      THEN RETURN record_error(400,'invalid_idempotency_key'); END IF;
    idempotency:=(payload->>'key')::uuid;
    digest:=sha256(convert_to(queue_name,'UTF8'));
    result:=record_replay(record_caller_scope(actor),'DELETE','/v1/queues/' || queue_name,idempotency,digest);
    IF result IS NOT NULL THEN RETURN result; END IF;
    SELECT * INTO q FROM message_queues WHERE tenant_id=tenant AND name=queue_name FOR UPDATE;
    IF NOT FOUND OR q.owner_app_id IS DISTINCT FROM actor THEN
      PERFORM audit_append('audit.queue_delete','audit',request_id,0,'denied','queue_forbidden');
      RETURN record_error(403,'queue_forbidden');
    END IF;
    IF EXISTS (SELECT FROM queue_messages WHERE tenant_id=tenant AND queue_id=q.queue_id
        AND (payload_json IS NOT NULL OR dead_at IS NOT NULL)) THEN
      RETURN record_error(409,'queue_not_empty');
    END IF;
    DELETE FROM queue_messages WHERE tenant_id=tenant AND queue_id=q.queue_id;
    DELETE FROM message_queues WHERE tenant_id=tenant AND queue_id=q.queue_id;
    PERFORM audit_append('audit.queue_delete','audit',q.queue_id,0,'success',NULL,request_id::text);
    result:=jsonb_build_object('status',204);
    PERFORM record_save_replay(record_caller_scope(actor),'DELETE','/v1/queues/' || queue_name,idempotency,digest,result);
    RETURN result;
  END IF;

  IF operation = 'configure' THEN$body$);
END $$;
RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (74);
NOTIFY pgrst,'reload schema';
COMMIT;
