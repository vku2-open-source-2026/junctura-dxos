-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
-- Server-generated request correlation for the successful grant activation,
-- grant revocation, application assignment grant and application assignment
-- revocation audit events. Correlated rows are sealed under schema version 3,
-- so historical event hashes stay exactly as recorded, the reason field keeps
-- its existing semantics and export and verification keep covering the new
-- field. Application assignments persist the originating request id and keep
-- it while a transition is pending, so provider retries and worker confirms
-- still correlate to the initiating request instead of a replay.
BEGIN;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

ALTER TABLE app_private.audit ADD COLUMN request_id uuid;
ALTER TABLE app_private.app_assignments ADD COLUMN request_id uuid;

ALTER TABLE app_private.audit DROP CONSTRAINT audit_schema_version_check;
ALTER TABLE app_private.audit ADD CONSTRAINT audit_schema_version_check CHECK (
  (schema_version=2 AND event IN ('audit.application_event','audit.resource_consent_access') AND request_id IS NULL) OR
  (schema_version=3 AND event NOT IN ('audit.application_event','audit.resource_consent_access') AND request_id IS NOT NULL) OR
  (schema_version=1 AND event NOT IN ('audit.application_event','audit.resource_consent_access') AND request_id IS NULL));

-- Version 3 entries re-commit to the unchanged version 1 row hash plus the
-- request id; version 1 and 2 digests stay exactly as recorded.
CREATE OR REPLACE FUNCTION app_private.audit_entry_hash(a app_private.audit,p_seq bigint,p_prev text) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,app_private,pg_temp AS $$
  SELECT CASE a.schema_version
    WHEN 1 THEN audit_entry_hash_v1(a,p_seq,p_prev)
    WHEN 3 THEN encode(sha256(convert_to(jsonb_build_array('junctura-audit/3',
      audit_entry_hash_v1(a,p_seq,p_prev),a.request_id::text)::text,'UTF8')),'hex')
    ELSE encode(sha256(convert_to(jsonb_build_array('junctura-audit/2',
      audit_entry_hash_v1(a,p_seq,p_prev),p.entry,p.visible_to_subject)::text,'UTF8')),'hex') END
  FROM (SELECT 1) seed LEFT JOIN audit_app_payloads p ON p.tenant_id=a.tenant_id AND p.event_id=a.event_id
$$;

-- Correlated platform events are management-visible like version 1 rows, so
-- the actor filter must keep matching them.
CREATE OR REPLACE FUNCTION app_private.audit_filter(a app_private.audit,entry jsonb,p_filter jsonb,p_view jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT (NOT p_filter ? 'action' OR p_filter->>'action'=coalesce(entry->>'action',a.event))
    AND (NOT p_filter ? 'subjectId' OR (entry->>'subjectId'=p_filter->>'subjectId'
      AND (p_view->>'mode'='app' OR entry->>'sensitivity'='standard')))
    AND (NOT p_filter ? 'unit' OR entry->>'unit'=p_filter->>'unit')
    -- A match must not reveal actors from redacted application events.
    AND (NOT p_filter ? 'actor' OR (a.subject=p_filter->>'actor'
      AND (a.schema_version IN (1,3) OR p_view->>'mode'='app'
        OR (p_view->>'mode'='regulator' AND entry->>'sensitivity'='standard'))))
$$;

-- Correlated appends under a distinct name keep the seven-argument
-- audit_append and every existing call arity unambiguous. All arguments are
-- required; callers without correlation keep using audit_append unchanged.
CREATE FUNCTION app_private.audit_request(
  p_event text, p_resource_type text, p_resource_id uuid, p_revision integer,
  p_outcome text, p_reason_code text, p_reason text, p_request text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private AS $$
DECLARE c jsonb; tenant text; event uuid;
BEGIN
  BEGIN c:=current_setting('request.jwt.claims',true)::jsonb;
  EXCEPTION WHEN others THEN c:=NULL; END;
  IF c IS NULL OR jsonb_typeof(c)<>'object' THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='audit actor claims required';
  END IF;
  tenant:=c->>'tenant_id';
  IF tenant IS NULL OR tenant !~ '^[a-z][a-z0-9-]{0,62}$' THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='audit tenant required';
  END IF;
  INSERT INTO app_private.audit(tenant_id,issuer,subject,management_client,event,
    resource_type,resource_id,revision,outcome,reason_code,reason,request_id)
    VALUES(tenant,c->>'iss',c->>'sub',c->>'client_id',p_event,p_resource_type,p_resource_id,
      p_revision,p_outcome,p_reason_code,p_reason,
      CASE WHEN p_request ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN p_request::uuid END)
    RETURNING event_id INTO event;
  RETURN event;
END $$;

DO $$
DECLARE change record; definition text;
BEGIN
  FOR change IN SELECT * FROM (VALUES
    ('app_private.audit_guard()',
      $old$  NEW.schema_version:=CASE WHEN NEW.event IN ('audit.application_event','audit.resource_consent_access') THEN 2 ELSE 1 END; NEW.reason:=app_private.audit_redact_text(NEW.reason);$old$,
      $new$  NEW.schema_version:=CASE WHEN NEW.event IN ('audit.application_event','audit.resource_consent_access') THEN 2 WHEN NEW.request_id IS NOT NULL THEN 3 ELSE 1 END; NEW.reason:=app_private.audit_redact_text(NEW.reason);$new$),
    ('app_private.audit_projection(app_private.audit,jsonb,jsonb)',
      $old$    'outcome',a.outcome,'reasonCode',a.reason_code,'reason',a.reason)
  ELSE jsonb_build_object('source','application','eventId',a.event_id,'appId',a.actor_app_id,'occurredAt',a.occurred_at)$old$,
      $new$    'outcome',a.outcome,'reasonCode',a.reason_code,'reason',a.reason)
  WHEN a.schema_version=3 THEN jsonb_build_object(
    'eventId',a.event_id,'occurredAt',a.occurred_at,'tenantId',a.tenant_id,
    'schemaVersion',a.schema_version,'event',a.event,'resourceType',a.resource_type,
    'resourceId',a.resource_id,'revision',a.revision,'actorAppId',a.actor_app_id,
    'issuer',a.issuer,'subject',a.subject,'managementClient',a.management_client,
    'outcome',a.outcome,'reasonCode',a.reason_code,'reason',a.reason,'requestId',a.request_id)
  ELSE jsonb_build_object('source','application','eventId',a.event_id,'appId',a.actor_app_id,'occurredAt',a.occurred_at)$new$),
    ('core.audit_query(jsonb)',
      $old$WHERE a.tenant_id=tenant AND (a.schema_version=1 OR p.event_id IS NOT NULL)$old$,
      $new$WHERE a.tenant_id=tenant AND (a.schema_version IN (1,3) OR p.event_id IS NOT NULL)$new$),
    ('core.audit_app_export(text,jsonb)',
      $old$WHERE a.tenant_id=tenant AND a.chain_seq<=head.last_seq AND (a.schema_version=1 OR p.event_id IS NOT NULL)$old$,
      $new$WHERE a.tenant_id=tenant AND a.chain_seq<=head.last_seq AND (a.schema_version IN (1,3) OR p.event_id IS NOT NULL)$new$),
    ('core.trust_command(text,jsonb)',
      $old$  PERFORM app_private.audit_append(event_name,'grant',g.grant_id,g.revision,'success',NULL,payload->>'reason');$old$,
      $new$  PERFORM app_private.audit_request(event_name,'grant',g.grant_id,g.revision,'success',NULL,payload->>'reason',
    CASE WHEN operation IN ('activate','revoke') THEN claims->>'request_id' END);$new$),
    ('core.application_management(text,jsonb)',
      $old$    INSERT INTO app_assignments AS s(tenant_id,app_id,unit,target_type,target,app_role)
      VALUES(tenant,a.app_id,payload->>'unit',payload->>'targetType',assignee,payload->>'role')
      ON CONFLICT(tenant_id,app_id,unit,target_type,target,app_role) DO UPDATE
        SET enabled=true,synchronized=s.enabled AND s.synchronized,
            assignment_id=CASE WHEN NOT s.enabled AND s.synchronized THEN gen_random_uuid() ELSE s.assignment_id END
      WHERE s.enabled OR s.synchronized
      RETURNING * INTO x;$old$,
      $new$    INSERT INTO app_assignments AS s(tenant_id,app_id,unit,target_type,target,app_role,request_id)
      VALUES(tenant,a.app_id,payload->>'unit',payload->>'targetType',assignee,payload->>'role',(c->>'request_id')::uuid)
      ON CONFLICT(tenant_id,app_id,unit,target_type,target,app_role) DO UPDATE
        SET enabled=true,synchronized=s.enabled AND s.synchronized,
            assignment_id=CASE WHEN NOT s.enabled AND s.synchronized THEN gen_random_uuid() ELSE s.assignment_id END,
            request_id=CASE WHEN s.enabled THEN s.request_id ELSE (c->>'request_id')::uuid END
      WHERE s.enabled OR s.synchronized
      RETURNING * INTO x;$new$),
    ('core.application_management(text,jsonb)',
      $old$      synchronized=CASE WHEN operation='assignment_delete' THEN NOT s.enabled AND s.synchronized ELSE true END
      WHERE s.tenant_id=tenant AND s.app_id=a.app_id AND s.assignment_id=(payload->>'assignmentId')::uuid$old$,
      $new$      synchronized=CASE WHEN operation='assignment_delete' THEN NOT s.enabled AND s.synchronized ELSE true END,
      request_id=CASE WHEN operation='assignment_delete' AND s.enabled THEN (c->>'request_id')::uuid ELSE s.request_id END
      WHERE s.tenant_id=tenant AND s.app_id=a.app_id AND s.assignment_id=(payload->>'assignmentId')::uuid$new$),
    ('core.application_management(text,jsonb)',
      $old$    PERFORM audit_append(event_name,'application',a.app_id,a.revision,'success',NULL,x.assignment_id::text);$old$,
      $new$    PERFORM audit_request(event_name,'application',a.app_id,a.revision,'success',NULL,x.assignment_id::text,
      x.request_id::text);$new$)
  ) AS v(signature,old_text,new_text) LOOP
    definition:=pg_get_functiondef(change.signature::regprocedure);
    IF (length(definition)-length(replace(definition,change.old_text,'')))<>length(change.old_text)
      THEN RAISE EXCEPTION 'Unexpected request correlation anchor for %',change.signature; END IF;
    EXECUTE replace(definition,change.old_text,change.new_text);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION app_private.audit_request(text,text,uuid,integer,text,text,text,text) FROM PUBLIC,junctura_api,junctura_app_api,junctura_resource_api,junctura_audit_api;
RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (75);
NOTIFY pgrst,'reload schema';
COMMIT;
