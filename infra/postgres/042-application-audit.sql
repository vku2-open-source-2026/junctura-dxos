-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

ALTER TABLE app_private.audit DROP CONSTRAINT audit_schema_version_check;
ALTER TABLE app_private.audit ADD CONSTRAINT audit_schema_version_check CHECK (
  (schema_version=2 AND event='audit.application_event') OR
  (schema_version=1 AND event<>'audit.application_event'));

CREATE TABLE app_private.audit_app_payloads (
  tenant_id text NOT NULL,
  event_id uuid NOT NULL,
  entry jsonb NOT NULL CHECK (jsonb_typeof(entry)='object'),
  visible_to_subject boolean NOT NULL,
  PRIMARY KEY (tenant_id,event_id),
  FOREIGN KEY (tenant_id,event_id) REFERENCES app_private.audit(tenant_id,event_id)
);
CREATE INDEX audit_app_subject_idx ON app_private.audit_app_payloads (tenant_id,(entry->>'subjectId'))
  WHERE visible_to_subject AND entry->>'sensitivity'='standard';
CREATE INDEX audit_app_unit_idx ON app_private.audit_app_payloads (tenant_id,(entry->>'unit'));
CREATE INDEX audit_actor_time_idx ON app_private.audit (tenant_id,actor_app_id,occurred_at DESC,event_id DESC);

-- Operator-managed bindings are scoped to the enrolled app and its issuer.
CREATE TABLE app_private.audit_app_units (
  tenant_id text NOT NULL,
  app_id uuid NOT NULL,
  unit text NOT NULL,
  PRIMARY KEY (tenant_id,app_id),
  FOREIGN KEY (tenant_id,app_id) REFERENCES app_private.applications(tenant_id,app_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,unit) REFERENCES app_private.directory_units(tenant_id,unit) ON DELETE CASCADE
);
CREATE TABLE app_private.audit_app_delegates (
  tenant_id text NOT NULL,
  app_id uuid NOT NULL,
  login_subject text NOT NULL,
  PRIMARY KEY (tenant_id,app_id,login_subject),
  FOREIGN KEY (tenant_id,app_id) REFERENCES app_private.applications(tenant_id,app_id) ON DELETE CASCADE
);
CREATE TABLE app_private.audit_app_rate (
  tenant_id text NOT NULL,
  app_id uuid NOT NULL,
  minute timestamptz NOT NULL,
  used integer NOT NULL,
  PRIMARY KEY (tenant_id,app_id),
  FOREIGN KEY (tenant_id,app_id) REFERENCES app_private.applications(tenant_id,app_id) ON DELETE CASCADE
);
CREATE TABLE app_private.audit_export_snapshots (
  tenant_id text NOT NULL,
  snapshot_id uuid NOT NULL DEFAULT gen_random_uuid(),
  caller_scope bytea NOT NULL,
  view_scope jsonb NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes',
  PRIMARY KEY (tenant_id,snapshot_id)
);
CREATE TABLE app_private.audit_export_lines (
  tenant_id text NOT NULL,
  snapshot_id uuid NOT NULL,
  sequence bigint NOT NULL,
  line jsonb NOT NULL,
  PRIMARY KEY (tenant_id,snapshot_id,sequence),
  FOREIGN KEY (tenant_id,snapshot_id) REFERENCES app_private.audit_export_snapshots(tenant_id,snapshot_id) ON DELETE CASCADE
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['audit_app_payloads','audit_app_units','audit_app_delegates','audit_app_rate',
    'audit_export_snapshots','audit_export_lines'] LOOP
    EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app_private.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON app_private.%I TO junctura_app_owner
      USING (tenant_id=app_private.record_tenant()) WITH CHECK (tenant_id=app_private.record_tenant())', t);
  END LOOP;
END $$;

CREATE FUNCTION app_private.audit_app_actor()
RETURNS TABLE(app_id uuid, actor jsonb, unit text)
LANGUAGE plpgsql SET search_path=pg_catalog,app_private,pg_temp AS $$
DECLARE
  c jsonb := current_setting('request.jwt.claims',true)::jsonb;
  enrolled record;
BEGIN
  SELECT a.app_id AS id,e.resource_subject INTO enrolled
  FROM applications a JOIN enrollments e USING (tenant_id,issuer,oauth_client_id,owner_subject,provider_origin)
  WHERE a.tenant_id=record_tenant() AND a.issuer=c->>'iss' AND a.oauth_client_id=c->>'client_id'
    AND a.state='active' AND e.enabled
  FOR SHARE OF a,e;
  IF NOT FOUND THEN RETURN; END IF;
  app_id:=enrolled.id;
  IF enrolled.resource_subject=c->>'sub' THEN
    actor:=jsonb_build_object('kind','application');
    SELECT u.unit INTO unit FROM audit_app_units b JOIN directory_units u USING (tenant_id,unit)
    WHERE b.tenant_id=record_tenant() AND b.app_id=enrolled.id AND NOT u.pending_delete;
  ELSE
    PERFORM FROM audit_app_delegates d
    JOIN subject_bindings b ON b.tenant_id=d.tenant_id AND b.login_subject=d.login_subject
    WHERE d.tenant_id=record_tenant() AND d.app_id=enrolled.id AND d.login_subject=c->>'sub'
      AND b.issuer=c->>'iss' AND b.subject_id=c->>'subject_id'
    FOR SHARE OF d,b;
    IF NOT FOUND THEN RETURN; END IF;
    actor:=jsonb_build_object('kind','user','subject',c->>'subject_id');
    IF jsonb_array_length(coalesce(c->'units','[]'::jsonb))=1 THEN
      unit:=c->'units'->>0;
    END IF;
  END IF;
  RETURN NEXT;
END $$;

ALTER FUNCTION app_private.audit_entry_hash(app_private.audit,bigint,text) RENAME TO audit_entry_hash_v1;
CREATE FUNCTION app_private.audit_entry_hash(a app_private.audit,p_seq bigint,p_prev text) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,app_private,pg_temp AS $$
  SELECT CASE WHEN a.schema_version=1 THEN audit_entry_hash_v1(a,p_seq,p_prev)
    ELSE encode(sha256(convert_to(jsonb_build_array('junctura-audit/2',
      audit_entry_hash_v1(a,p_seq,p_prev),p.entry,p.visible_to_subject)::text,'UTF8')),'hex') END
  FROM (SELECT 1) seed LEFT JOIN audit_app_payloads p ON p.tenant_id=a.tenant_id AND p.event_id=a.event_id
$$;

-- Called with the audit chain lock held. Platform writers can continue
-- inserting pending rows while the sealer takes its own snapshot of them.
CREATE FUNCTION app_private.audit_seal_pending() RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog,app_private,pg_temp AS $$
DECLARE
  tenant text := record_tenant();
  s bigint := 0;
  h text := repeat('0',64);
  head audit_chain_heads;
  r record;
  sealed integer := 0;
BEGIN
  SELECT * INTO head FROM audit_chain_heads WHERE tenant_id=tenant;
  IF FOUND THEN s:=head.last_seq; h:=head.last_hash; END IF;
  FOR r IN SELECT event_id FROM audit WHERE tenant_id=tenant AND chain_seq IS NULL ORDER BY occurred_at,event_id LOOP
    s:=s+1;
    UPDATE audit a SET chain_seq=s,prev_hash=h,entry_hash=audit_entry_hash(a,s,h)
      WHERE a.tenant_id=tenant AND a.event_id=r.event_id RETURNING entry_hash INTO h;
    sealed:=sealed+1;
  END LOOP;
  IF sealed>0 THEN
    INSERT INTO audit_chain_heads(tenant_id,last_seq,last_hash,sealed_at) VALUES(tenant,s,h,clock_timestamp())
      ON CONFLICT (tenant_id) DO UPDATE SET last_seq=EXCLUDED.last_seq,last_hash=EXCLUDED.last_hash,sealed_at=EXCLUDED.sealed_at;
  END IF;
  RETURN sealed;
END $$;

CREATE OR REPLACE FUNCTION app_private.audit_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private,pg_temp AS $$
DECLARE
  c jsonb; tenant text; who text; iss text; client text; actor uuid; derived text;
BEGIN
  BEGIN c := current_setting('request.jwt.claims',true)::jsonb;
  EXCEPTION WHEN others THEN c := NULL; END;
  IF c IS NULL OR jsonb_typeof(c)<>'object' THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='audit actor claims required';
  END IF;
  tenant:=c->>'tenant_id'; who:=c->>'sub'; iss:=c->>'iss'; client:=c->>'client_id';
  IF tenant IS NULL OR tenant !~ '^[a-z][a-z0-9-]{0,62}$' OR coalesce(who,'')='' OR
     coalesce(iss,'')='' OR coalesce(client,'')='' THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='audit actor claims invalid';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM tenant THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='audit tenant mismatch';
  END IF;
  IF NEW.event IS NULL OR NEW.event !~ '^(application|approval|resource|capability|grant|delegation|composition|execution|invocation|authorization|audit)\.[a-z][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid audit event';
  END IF;
  IF NEW.resource_id IS NULL OR NEW.revision IS NULL OR NEW.revision<0 THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid audit target';
  END IF;
  derived:=CASE split_part(NEW.event,'.',1)
    WHEN 'resource' THEN 'resource_share'
    ELSE split_part(NEW.event,'.',1) END;
  IF NEW.resource_type IS NULL THEN NEW.resource_type:=derived; END IF;
  IF NEW.resource_type IS DISTINCT FROM derived THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid audit resource type';
  END IF;
  IF NEW.outcome IS NULL THEN NEW.outcome:='success'; END IF;
  IF NEW.outcome NOT IN ('success','denied','failed','unknown') THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid audit outcome';
  END IF;
  IF NEW.reason_code IS NOT NULL AND NEW.reason_code !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid audit reason code';
  END IF;
  IF NEW.event = 'audit.application_event' THEN
    IF c->>'role' IS DISTINCT FROM 'junctura_audit_api' THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='application audit entry requires audit command';
    END IF;
    SELECT app_id INTO actor FROM app_private.audit_app_actor();
    IF actor IS NULL OR NEW.resource_id IS DISTINCT FROM actor THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='application audit actor mismatch';
    END IF;
  ELSE
    actor:=core.resource_actor();
  END IF;
  NEW.tenant_id:=tenant; NEW.issuer:=iss; NEW.subject:=who; NEW.management_client:=client;
  NEW.actor_app_id:=actor; NEW.event_id:=gen_random_uuid(); NEW.occurred_at:=clock_timestamp();
  NEW.schema_version:=CASE WHEN NEW.event='audit.application_event' THEN 2 ELSE 1 END; NEW.reason:=app_private.audit_redact_text(NEW.reason);
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION core.audit_verify(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private,pg_temp AS $$
DECLARE
  c jsonb; tenant text; who text; iss text; client text;
  genesis constant text := repeat('0',64);
  r record; head record; prev text; seq bigint; sealed integer:=0;
  broken jsonb;
BEGIN
  IF payload IS NULL OR jsonb_typeof(payload)<>'object' OR payload<>'{}'::jsonb THEN
    RETURN jsonb_build_object('status',400,'error','invalid_audit_verification');
  END IF;
  BEGIN c:=current_setting('request.jwt.claims',true)::jsonb;
  EXCEPTION WHEN others THEN c:=NULL; END;
  IF c IS NULL OR jsonb_typeof(c)<>'object' THEN
    RETURN jsonb_build_object('status',403,'error','audit_permission_required');
  END IF;
  tenant:=c->>'tenant_id'; who:=c->>'sub'; iss:=c->>'iss'; client:=c->>'client_id';
  IF tenant IS NULL OR tenant !~ '^[a-z][a-z0-9-]{0,62}$' OR coalesce(who,'')='' OR
     coalesce(iss,'')='' OR coalesce(client,'')='' THEN
    RETURN jsonb_build_object('status',403,'error','audit_permission_required');
  END IF;
  PERFORM 1 FROM app_private.principals p
    WHERE p.tenant_id=tenant AND p.issuer=iss AND p.subject=who
      AND p.management_client=client AND p.enabled
      AND p.permissions @> ARRAY['audit.read']::text[];
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status',403,'error','audit_permission_required');
  END IF;

  -- Serialize verification with application appends and export snapshots.
  PERFORM pg_advisory_xact_lock(hashtextextended('junctura.audit_chain:' || tenant, 0));

  -- 1. Verify everything already sealed, in chain order.
  prev:=genesis; seq:=0;
  FOR r IN SELECT a AS entry, a.chain_seq, a.prev_hash, a.entry_hash AS stored, a.event_id
      FROM app_private.audit a
      WHERE a.tenant_id=tenant AND a.chain_seq IS NOT NULL ORDER BY a.chain_seq LOOP
    IF r.chain_seq<>seq+1 THEN
      broken:=jsonb_build_object('chainSeq',seq+1,'eventId',NULL,'reason','missing_entry'); EXIT;
    END IF;
    IF r.prev_hash<>prev THEN
      broken:=jsonb_build_object('chainSeq',r.chain_seq,'eventId',r.event_id,'reason','chain_link_mismatch'); EXIT;
    END IF;
    IF app_private.audit_entry_hash(r.entry, r.chain_seq, r.prev_hash)<>r.stored THEN
      broken:=jsonb_build_object('chainSeq',r.chain_seq,'eventId',r.event_id,'reason','content_modified'); EXIT;
    END IF;
    seq:=r.chain_seq; prev:=r.stored;
  END LOOP;
  SELECT * INTO head FROM app_private.audit_chain_heads h WHERE h.tenant_id=tenant;
  IF broken IS NULL AND head.tenant_id IS NOT NULL AND (head.last_seq<>seq OR head.last_hash<>prev) THEN
    broken:=jsonb_build_object('chainSeq',head.last_seq,'eventId',NULL,
      'reason',CASE WHEN head.last_seq>seq THEN 'missing_entry' ELSE 'head_mismatch' END);
  END IF;
  IF broken IS NULL AND head.tenant_id IS NULL AND seq>0 THEN
    broken:=jsonb_build_object('chainSeq',seq,'eventId',NULL,'reason','head_mismatch');
  END IF;

  -- 2. Seal pending events only on an intact chain, so a break is never hidden
  --    behind newer seals.
  IF broken IS NULL THEN
    sealed:=app_private.audit_seal_pending();
    SELECT * INTO head FROM app_private.audit_chain_heads h WHERE h.tenant_id=tenant;
    seq:=coalesce(head.last_seq,0); prev:=coalesce(head.last_hash,genesis);
  END IF;

  RETURN jsonb_build_object('status',200,'value',jsonb_build_object(
    'verified', broken IS NULL,
    'entries', seq,
    'newlySealed', sealed,
    'headHash', CASE WHEN broken IS NULL AND seq>0 THEN 'sha256:' || prev ELSE NULL END,
    'firstBreak', broken,
    'verifiedAt', to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
END $$;

CREATE FUNCTION core.audit_app_append(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private,pg_temp AS $$
DECLARE
  tenant text := record_tenant();
  path constant text := '/v1/audit-events';
  body jsonb := payload->'body';
  request_key uuid;
  request_digest bytea;
  writer record;
  catalog app_audit_actions;
  scope bytea;
  result jsonb;
  entry audit;
  bucket timestamptz := date_trunc('minute',clock_timestamp());
BEGIN
  IF current_setting('request.jwt.claims',true)::jsonb->'resource_writer' IS DISTINCT FROM 'true'::jsonb THEN
    RETURN record_error(403,'insufficient_role');
  END IF;
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object' OR payload-ARRAY['key','body']<>'{}'::jsonb
    OR coalesce(payload->>'key','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(body) IS DISTINCT FROM 'object'
    OR NOT (body ?& ARRAY['action','resourceRef','outcome','purpose'])
    OR body-ARRAY['action','subjectId','resourceRef','outcome','purpose','meta']<>'{}'::jsonb THEN
    RETURN record_error(400,'invalid_audit_event');
  END IF;
  IF body ? 'meta' THEN
    IF jsonb_typeof(body->'meta') <> 'object' OR record_compact_bytes(body->'meta') > 2048 THEN
      RETURN record_error(400,'invalid_audit_meta');
    END IF;
    IF EXISTS (SELECT FROM jsonb_each(body->'meta') m
      WHERE m.key !~ '^[A-Za-z_][A-Za-z0-9_]{0,63}$'
        OR jsonb_typeof(m.value) NOT IN ('string','number','boolean','null')) THEN
      RETURN record_error(400,'invalid_audit_meta');
    END IF;
  END IF;
  IF record_compact_bytes(body) > 16384 THEN RETURN record_error(413,'body_too_large'); END IF;
  request_digest:=sha256(convert_to(body::text,'UTF8'));
  request_key:=(payload->>'key')::uuid;
  SELECT * INTO writer FROM audit_app_actor();
  IF NOT FOUND THEN RETURN record_error(403,'audit_app_required'); END IF;
  scope:=record_caller_scope(writer.app_id);
  result:=record_replay(scope,'POST',path,request_key,request_digest);
  IF result IS NOT NULL THEN RETURN result; END IF;

  SELECT * INTO catalog FROM app_audit_actions
    WHERE tenant_id=tenant AND app_id=writer.app_id AND action=body->>'action' FOR SHARE;
  IF NOT FOUND THEN
    result:=record_error(422,'unknown_action');
    PERFORM record_save_replay(scope,'POST',path,request_key,request_digest,result);
    RETURN result;
  END IF;

  INSERT INTO audit_app_rate AS r (tenant_id,app_id,minute,used) VALUES (tenant,writer.app_id,bucket,1)
  ON CONFLICT (tenant_id,app_id) DO UPDATE
  SET minute=greatest(r.minute,excluded.minute), used=CASE WHEN r.minute<excluded.minute THEN 1 ELSE r.used+1 END
  WHERE r.minute<excluded.minute OR r.used<120;
  IF NOT FOUND THEN RETURN record_error(429,'rate_limited'); END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('junctura.audit_chain:' || tenant,0));
  INSERT INTO audit(tenant_id,event,resource_id,revision,outcome)
  VALUES(tenant,'audit.application_event',writer.app_id,1,body->>'outcome')
  RETURNING * INTO entry;
  INSERT INTO audit_app_payloads(tenant_id,event_id,entry,visible_to_subject)
  VALUES(tenant,entry.event_id,body || jsonb_build_object('actor',writer.actor,'unit',writer.unit,
    'sensitivity',catalog.sensitivity),catalog.visible_to_subject);
  PERFORM audit_seal_pending();
  result:=jsonb_build_object('status',201,'value',jsonb_build_object('eventId',entry.event_id,
    'appId',writer.app_id,'occurredAt',entry.occurred_at,'actor',writer.actor));
  PERFORM record_save_replay(scope,'POST',path,request_key,request_digest,result);
  RETURN result;
END $$;

-- Shared by the subject history RPC and the access-report authorization check.
CREATE FUNCTION app_private.audit_subject_entries(p_subject_id text)
RETURNS TABLE(event_id uuid, occurred_at timestamptz, app_id uuid, action text, purpose text, outcome text)
LANGUAGE sql STABLE SET search_path=pg_catalog,app_private,pg_temp AS $$
  SELECT a.event_id,a.occurred_at,a.actor_app_id,p.entry->>'action',p.entry->>'purpose',a.outcome
  FROM audit_app_payloads p JOIN audit a USING (tenant_id,event_id)
  JOIN subject_bindings b ON b.tenant_id=a.tenant_id AND b.issuer=a.issuer AND b.subject_id=p_subject_id
  CROSS JOIN (SELECT current_setting('request.jwt.claims',true)::jsonb AS c) req
  WHERE p.tenant_id=record_tenant() AND p.visible_to_subject AND p.entry->>'sensitivity'='standard'
    AND p.entry->>'subjectId'=p_subject_id AND a.issuer=req.c->>'iss'
    AND b.login_subject=req.c->>'sub' AND b.subject_id=req.c->>'subject_id'
$$;

CREATE FUNCTION app_private.audit_view_scope(p_app boolean) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,app_private,pg_temp AS $$
DECLARE
  c jsonb := current_setting('request.jwt.claims',true)::jsonb;
  actor uuid;
BEGIN
  IF p_app THEN
    SELECT a.app_id INTO actor FROM audit_app_actor() a;
    IF actor IS NOT NULL THEN RETURN jsonb_build_object('mode','app','appId',actor); END IF;
  ELSIF c->'regulator'='true'::jsonb THEN
    RETURN jsonb_build_object('mode','regulator','units',coalesce(c->'units','[]'::jsonb));
  ELSIF EXISTS (SELECT FROM principals p WHERE p.tenant_id=record_tenant()
    AND p.issuer=c->>'iss' AND p.subject=c->>'sub' AND p.management_client=c->>'client_id'
    AND p.enabled AND p.permissions @> ARRAY['audit.read']::text[]) THEN
    RETURN '{"mode":"management"}'::jsonb;
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION app_private.audit_visible(p_view jsonb,p_app uuid,p_entry jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE p_view->>'mode'
    WHEN 'app' THEN p_entry IS NOT NULL AND p_app::text=p_view->>'appId'
    WHEN 'regulator' THEN (p_view->'units') ? (p_entry->>'unit')
    WHEN 'management' THEN true ELSE false END
$$;

CREATE FUNCTION app_private.audit_projection(a app_private.audit,p_entry jsonb,p_view jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN a.schema_version=1 THEN jsonb_build_object(
    'eventId',a.event_id,'occurredAt',a.occurred_at,'tenantId',a.tenant_id,
    'schemaVersion',a.schema_version,'event',a.event,'resourceType',a.resource_type,
    'resourceId',a.resource_id,'revision',a.revision,'actorAppId',a.actor_app_id,
    'issuer',a.issuer,'subject',a.subject,'managementClient',a.management_client,
    'outcome',a.outcome,'reasonCode',a.reason_code,'reason',a.reason)
  ELSE jsonb_build_object('source','application','eventId',a.event_id,'appId',a.actor_app_id,'occurredAt',a.occurred_at)
    || CASE WHEN p_view->>'mode'='management' OR (p_view->>'mode'='regulator' AND p_entry->>'sensitivity'='restricted')
      THEN jsonb_build_object('unit',p_entry->'unit','action',p_entry->'action',
        'outcome',a.outcome,'sensitivity',p_entry->'sensitivity')
      ELSE p_entry END
  END
$$;

CREATE FUNCTION app_private.audit_filter_error(p_filter jsonb,p_view jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,app_private,pg_temp AS $$
  SELECT CASE
    WHEN p_view IS NULL THEN record_error(403,'audit_permission_required')
    WHEN p_filter ? 'unit' AND (p_view->>'mode'<>'regulator' OR NOT (p_view->'units' ? (p_filter->>'unit')))
      THEN record_error(403,'audit_permission_required')
    WHEN p_filter ? 'subjectId' AND p_view->>'mode'='management' THEN record_error(403,'audit_permission_required')
  END
$$;

CREATE FUNCTION app_private.audit_filter(a app_private.audit,entry jsonb,p_filter jsonb,p_view jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT (NOT p_filter ? 'action' OR p_filter->>'action'=coalesce(entry->>'action',a.event))
    AND (NOT p_filter ? 'subjectId' OR (entry->>'subjectId'=p_filter->>'subjectId'
      AND (p_view->>'mode'='app' OR entry->>'sensitivity'='standard')))
    AND (NOT p_filter ? 'unit' OR entry->>'unit'=p_filter->>'unit')
$$;

CREATE OR REPLACE FUNCTION core.audit_query(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private,pg_temp AS $$
DECLARE
  tenant text := record_tenant();
  view_scope jsonb;
  problem jsonb;
  from_at timestamptz;
  to_at timestamptz;
  page_limit integer;
  cursor_scope text;
  cursor_parts text[];
  cursor_time timestamptz;
  cursor_id uuid;
  items jsonb;
  next_cursor text;
BEGIN
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object' OR EXISTS (SELECT FROM jsonb_object_keys(payload) k
      WHERE k NOT IN ('app','action','subjectId','unit','from','to','since','until','limit','cursor'))
    OR (payload ? 'app' AND payload->>'app' IS DISTINCT FROM 'self')
    OR (payload ? 'app' AND payload ? 'unit')
    OR (payload ? 'from' AND payload ? 'since') OR (payload ? 'to' AND payload ? 'until') THEN
    RETURN record_error(400,'invalid_audit_query');
  END IF;
  view_scope:=audit_view_scope(payload ? 'app');
  problem:=audit_filter_error(payload,view_scope);
  IF problem IS NOT NULL THEN RETURN problem; END IF;

  BEGIN
    page_limit:=coalesce((payload->>'limit')::integer,50);
    IF page_limit NOT BETWEEN 1 AND 100 THEN RETURN record_error(400,'invalid_audit_limit'); END IF;
    from_at:=coalesce(record_time('date-time',payload->>'from'),(payload->>'since')::timestamptz);
    to_at:=coalesce(record_time('date-time',payload->>'to'),(payload->>'until')::timestamptz);
    IF (payload ? 'from' AND from_at IS NULL) OR (payload ? 'to' AND to_at IS NULL)
      OR from_at>to_at OR (from_at IS NOT NULL AND NOT isfinite(from_at))
      OR (to_at IS NOT NULL AND NOT isfinite(to_at)) THEN
      RETURN record_error(400,'invalid_audit_time_range');
    END IF;
    cursor_scope:=encode(sha256(convert_to(jsonb_build_array(tenant,encode(record_caller_scope(NULL),'hex'),
      view_scope,payload-ARRAY['limit','cursor'])::text,'UTF8')),'hex');
    IF payload ? 'cursor' THEN
      IF coalesce(length(payload->>'cursor'),0) NOT BETWEEN 64 AND 1024
        OR payload->>'cursor' !~ '^[0-9a-f]+$' THEN
        RETURN record_error(400,'invalid_cursor');
      END IF;
      BEGIN
        cursor_parts:=string_to_array(convert_from(decode(payload->>'cursor','hex'),'UTF8'),'|');
        IF NOT coalesce((cardinality(cursor_parts)=3 AND cursor_parts[3]=cursor_scope)
          OR (cardinality(cursor_parts)=2 AND view_scope->>'mode'='management'
            AND payload-ARRAY['since','until','cursor','limit']='{}'::jsonb),false) THEN
          RETURN record_error(400,'invalid_cursor');
        END IF;
        cursor_time:=cursor_parts[1]::timestamptz;
        cursor_id:=cursor_parts[2]::uuid;
        IF NOT isfinite(cursor_time) THEN RETURN record_error(400,'invalid_cursor'); END IF;
      EXCEPTION WHEN data_exception THEN
        RETURN record_error(400,'invalid_cursor');
      END;
    END IF;
  EXCEPTION WHEN data_exception THEN
    RETURN record_error(400,'invalid_audit_query');
  END;

  SELECT coalesce(jsonb_agg(projected ORDER BY occurred_at DESC,event_id DESC),'[]'::jsonb) INTO items
  FROM (
    SELECT a.occurred_at,a.event_id,audit_projection(a,p.entry,view_scope) AS projected
    FROM audit a LEFT JOIN audit_app_payloads p USING (tenant_id,event_id)
    WHERE a.tenant_id=tenant AND (a.schema_version=1 OR p.event_id IS NOT NULL)
      AND (from_at IS NULL OR a.occurred_at>=from_at) AND (to_at IS NULL OR a.occurred_at<=to_at)
      AND (cursor_time IS NULL OR (a.occurred_at,a.event_id)<(cursor_time,cursor_id))
      AND (view_scope->>'mode'<>'app' OR (p.event_id IS NOT NULL AND a.actor_app_id=(view_scope->>'appId')::uuid))
      AND (view_scope->>'mode'<>'regulator' OR p.entry->>'unit'=ANY(
        ARRAY(SELECT jsonb_array_elements_text(view_scope->'units'))))
      AND audit_filter(a,p.entry,payload,view_scope)
    ORDER BY a.occurred_at DESC,a.event_id DESC LIMIT page_limit+1
  ) selected;
  IF jsonb_array_length(items)>page_limit THEN
    next_cursor:=encode(convert_to((items->(page_limit-1)->>'occurredAt') || '|' ||
      (items->(page_limit-1)->>'eventId') || '|' || cursor_scope,'UTF8'),'hex');
    items:=items-page_limit;
  END IF;
  RETURN jsonb_build_object('status',200,'value',jsonb_build_object('items',items,'nextCursor',next_cursor));
END $$;

CREATE FUNCTION core.audit_app_export(operation text,payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private,pg_temp AS $$
DECLARE
  tenant text := record_tenant();
  scope bytea := record_caller_scope(NULL);
  snapshot uuid := (payload->>'snapshotId')::uuid;
  view_scope jsonb;
  problem jsonb;
  head audit_chain_heads;
  from_at timestamptz;
  to_at timestamptz;
  rows_inserted integer;
  after_seq bigint := coalesce((payload->>'after')::bigint,0);
  result jsonb;
BEGIN
  IF operation='end' THEN
    DELETE FROM audit_export_snapshots s WHERE s.tenant_id=tenant AND s.snapshot_id=snapshot AND s.caller_scope=scope;
    RETURN jsonb_build_object('status',204);
  END IF;
  IF operation='page' THEN
    SELECT s.view_scope INTO view_scope FROM audit_export_snapshots s
    WHERE s.tenant_id=tenant AND s.snapshot_id=snapshot AND s.caller_scope=scope
      AND s.expires_at>clock_timestamp();
    IF NOT FOUND THEN RETURN record_error(404,'not_found'); END IF;
    IF view_scope IS DISTINCT FROM audit_view_scope(view_scope->>'mode'='app') THEN
      RETURN record_error(403,'audit_permission_required');
    END IF;
    SELECT jsonb_build_object('lines',coalesce(jsonb_agg(line ORDER BY sequence),'[]'::jsonb),
      'nextAfter',CASE WHEN count(*)=100 THEN max(sequence)::text END) INTO result
    FROM (SELECT sequence,line FROM audit_export_lines l WHERE l.tenant_id=tenant AND l.snapshot_id=snapshot
      AND l.sequence>after_seq ORDER BY sequence LIMIT 100) page;
    RETURN jsonb_build_object('status',200,'value',result);
  END IF;
  IF operation<>'start' THEN RETURN record_error(400,'invalid_request'); END IF;

  view_scope:=audit_view_scope(payload ? 'app');
  problem:=audit_filter_error(payload,view_scope);
  IF problem IS NOT NULL THEN RETURN problem; END IF;
  from_at:=record_time('date-time',payload->>'from');
  to_at:=record_time('date-time',payload->>'to');
  IF (payload ? 'from' AND from_at IS NULL) OR (payload ? 'to' AND to_at IS NULL) OR from_at>to_at THEN
    RETURN record_error(400,'invalid_audit_time_range');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('junctura.audit_chain:' || tenant,0));
  DELETE FROM audit_export_snapshots WHERE tenant_id=tenant AND expires_at<=clock_timestamp();
  IF (SELECT count(*) FROM audit_export_snapshots WHERE tenant_id=tenant)>=2 THEN
    RETURN record_error(429,'rate_limited');
  END IF;
  PERFORM audit_seal_pending();
  SELECT * INTO head FROM audit_chain_heads WHERE tenant_id=tenant;
  INSERT INTO audit_export_snapshots(tenant_id,caller_scope,view_scope)
  VALUES(tenant,scope,view_scope) RETURNING snapshot_id INTO snapshot;
  INSERT INTO audit_export_lines(tenant_id,snapshot_id,sequence,line)
    SELECT tenant,snapshot,a.chain_seq,jsonb_build_object('type','event','sequence',a.chain_seq,
      'hash','sha256:' || a.entry_hash,'event',audit_projection(a,p.entry,view_scope))
    FROM audit a LEFT JOIN audit_app_payloads p USING (tenant_id,event_id)
    WHERE a.tenant_id=tenant AND a.chain_seq<=head.last_seq AND (a.schema_version=1 OR p.event_id IS NOT NULL)
      AND (from_at IS NULL OR a.occurred_at>=from_at) AND (to_at IS NULL OR a.occurred_at<=to_at)
      AND audit_visible(view_scope,a.actor_app_id,p.entry) AND audit_filter(a,p.entry,payload,view_scope)
    ORDER BY a.chain_seq LIMIT 10001;
  GET DIAGNOSTICS rows_inserted=ROW_COUNT;
  IF rows_inserted>10000 THEN
    DELETE FROM audit_export_snapshots s WHERE s.tenant_id=tenant AND s.snapshot_id=snapshot;
    RETURN record_error(400,'audit_export_too_large');
  END IF;
  RETURN jsonb_build_object('status',200,'value',jsonb_build_object('snapshotId',snapshot,'head',
    jsonb_build_object('type','chainHead','sequence',coalesce(head.last_seq,0),
      'hash','sha256:' || coalesce(head.last_hash,repeat('0',64)),'generatedAt',clock_timestamp())));
END $$;

REVOKE ALL ON FUNCTION app_private.audit_app_actor(),app_private.audit_seal_pending(),
  app_private.audit_entry_hash(app_private.audit,bigint,text),app_private.audit_subject_entries(text),
  app_private.audit_view_scope(boolean),app_private.audit_visible(jsonb,uuid,jsonb),
  app_private.audit_projection(app_private.audit,jsonb,jsonb),app_private.audit_filter_error(jsonb,jsonb),
  app_private.audit_filter(app_private.audit,jsonb,jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION core.audit_app_append(jsonb),core.audit_app_export(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.audit_app_append(jsonb),core.audit_app_export(text,jsonb) TO junctura_audit_api;

RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (42);
NOTIFY pgrst,'reload schema';
COMMIT;
