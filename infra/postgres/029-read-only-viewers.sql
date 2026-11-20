-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
-- Read-only viewers. A principal holding audit.read (an auditor or the public
-- demo viewer) may read every capability, every application and the emergency
-- access review queue of its tenant. Nothing here lets it change anything:
-- registration, approval, publishing and reviews keep their own permissions.
-- 009, 021 and 003 are unchanged; their functions are replaced here.

CREATE OR REPLACE FUNCTION core.capability_command(operation text,payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  c jsonb:=current_setting('request.jwt.claims',true)::jsonb; perms text[];
  publisher boolean; management boolean; auditor boolean; actor uuid; v app_private.capability_versions; owner_subject text;
  v_limit integer:=100; cursor_parts text[]; cursor_time timestamptz; cursor_id uuid; items jsonb; next_cursor text;
BEGIN
  IF operation NOT IN ('get','list') THEN RETURN app_private.capability_management_command(operation,payload); END IF;
  SELECT permissions INTO perms FROM app_private.principals WHERE tenant_id=c->>'tenant_id' AND issuer=c->>'iss'
    AND subject=c->>'sub' AND management_client=c->>'client_id' AND enabled;
  publisher:=coalesce('capabilities.publish'=ANY(perms),false);
  management:=publisher OR coalesce('capabilities.write'=ANY(perms),false);
  auditor:=coalesce('audit.read'=ANY(perms),false);
  actor:=core.resource_actor();
  IF NOT management AND NOT auditor AND actor IS NULL THEN RETURN jsonb_build_object('status',403,'error','capability_permission_required'); END IF;
  IF operation='get' THEN
    IF coalesce(payload->>'capabilityId','') !~ '^urn:junctura:capability:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[a-z][a-z0-9-]{0,62}$'
      OR coalesce(payload->>'version','') !~ '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$' THEN RETURN jsonb_build_object('status',400,'error','invalid_capability_reference'); END IF;
    SELECT cv.* INTO v FROM app_private.capability_versions cv JOIN app_private.applications a
      ON a.tenant_id=cv.tenant_id AND a.app_id=cv.provider_app_id AND a.issuer=c->>'iss'
      WHERE cv.tenant_id=c->>'tenant_id' AND cv.capability_id=payload->>'capabilityId' AND cv.version=payload->>'version';
    IF NOT FOUND THEN RETURN jsonb_build_object('status',404,'error','not_found'); END IF;
    SELECT a.owner_subject INTO owner_subject FROM app_private.applications a WHERE a.tenant_id=v.tenant_id AND a.app_id=v.provider_app_id;
    IF publisher OR auditor OR (management AND owner_subject=c->>'sub') THEN RETURN jsonb_build_object('status',200,'value',app_private.capability_version_view(v)); END IF;
    IF trust_private.granted(v,'discover') THEN RETURN jsonb_build_object('status',200,'value',trust_private.capability_view(v)); END IF;
    RETURN jsonb_build_object('status',404,'error','not_found');
  END IF;
  BEGIN
    IF EXISTS(SELECT FROM jsonb_object_keys(payload) k WHERE k NOT IN ('limit','cursor')) THEN RAISE EXCEPTION 'invalid query'; END IF;
    IF payload ? 'limit' THEN
      IF jsonb_typeof(payload->'limit')<>'number' OR payload->>'limit' !~ '^[0-9]{1,3}$' THEN RAISE EXCEPTION 'invalid limit'; END IF;
      v_limit:=(payload->>'limit')::integer;
      IF v_limit<1 OR v_limit>100 THEN RAISE EXCEPTION 'invalid limit'; END IF;
    END IF;
    IF payload ? 'cursor' THEN
      cursor_parts:=string_to_array(convert_from(decode(payload->>'cursor','hex'),'UTF8'),'|');
      IF management OR auditor THEN
        IF cardinality(cursor_parts)<>2 THEN RAISE EXCEPTION 'invalid cursor'; END IF;
        cursor_time:=cursor_parts[1]::timestamptz; cursor_id:=cursor_parts[2]::uuid;
      ELSE
        IF cardinality(cursor_parts)<>4 OR cursor_parts[1] IS DISTINCT FROM c->>'tenant_id' OR cursor_parts[2] IS DISTINCT FROM actor::text THEN RAISE EXCEPTION 'invalid cursor'; END IF;
        cursor_time:=cursor_parts[3]::timestamptz; cursor_id:=cursor_parts[4]::uuid;
      END IF;
    END IF;
  EXCEPTION WHEN others THEN RETURN jsonb_build_object('status',400,'error','invalid_capability_cursor'); END;
  SELECT coalesce(jsonb_agg(CASE WHEN publisher OR auditor OR (management AND a.owner_subject=c->>'sub') THEN app_private.capability_version_view(a.cv)
      ELSE trust_private.capability_view(a.cv) END ORDER BY (a.cv).updated_at DESC,(a.cv).version_id DESC),'[]'::jsonb)
    INTO items FROM (
      SELECT cv,app.owner_subject FROM app_private.capability_versions cv JOIN app_private.applications app
        ON app.tenant_id=cv.tenant_id AND app.app_id=cv.provider_app_id AND app.issuer=c->>'iss'
      WHERE cv.tenant_id=c->>'tenant_id' AND (publisher OR auditor OR (management AND app.owner_subject=c->>'sub') OR trust_private.granted(cv,'discover'))
        AND (cursor_time IS NULL OR (cv.updated_at,cv.version_id)<(cursor_time,cursor_id))
      ORDER BY cv.updated_at DESC,cv.version_id DESC LIMIT v_limit+1
    ) a;
  IF jsonb_array_length(items)>v_limit THEN
    next_cursor:=encode(convert_to(CASE WHEN management OR auditor THEN '' ELSE (c->>'tenant_id')||'|'||actor::text||'|' END ||
      (items->(v_limit-1)->>'updatedAt')||'|'||(items->(v_limit-1)->>'versionId'),'UTF8'),'hex');
    items:=items-v_limit;
  END IF;
  RETURN jsonb_build_object('status',200,'value',jsonb_build_object('items',items,'nextCursor',next_cursor));
END $$;

CREATE OR REPLACE FUNCTION core.emergency_review(operation text, payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c jsonb; tenant text; who text; iss text; client text; perms text[]; r execution_private.emergency_reviews; items jsonb;
BEGIN
  BEGIN c:=current_setting('request.jwt.claims',true)::jsonb;
  EXCEPTION WHEN others THEN c:=NULL; END;
  tenant:=c->>'tenant_id'; who:=c->>'sub'; iss:=c->>'iss'; client:=c->>'client_id';
  IF c IS NULL OR coalesce(tenant,'')='' OR coalesce(who,'')='' OR coalesce(iss,'')='' OR coalesce(client,'')='' THEN
    RETURN jsonb_build_object('status',403,'error','trust_permission_required');
  END IF;
  SELECT p.permissions INTO perms FROM app_private.principals p
    WHERE p.tenant_id=tenant AND p.issuer=iss AND p.subject=who AND p.management_client=client AND p.enabled;
  IF perms IS NULL OR NOT (perms && ARRAY['trust.approve','audit.read']::text[]) THEN RETURN jsonb_build_object('status',403,'error','trust_permission_required'); END IF;
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('status',400,'error','invalid_emergency_review'); END IF;
  IF operation='list' THEN
    IF payload<>'{}'::jsonb THEN RETURN jsonb_build_object('status',400,'error','invalid_emergency_review'); END IF;
    SELECT coalesce(jsonb_agg(execution_private.emergency_view(q.*) ORDER BY q.recorded_at DESC),'[]'::jsonb) INTO items FROM (
      SELECT er.*, x.recorded_at, x.purpose, x.justification, e.consumer_app_id, e.provider_app_id, e.capability_id, e.version, e.state AS execution_state
        FROM execution_private.emergency_reviews er
        JOIN execution_private.execution_contexts x ON x.tenant_id=er.tenant_id AND x.execution_id=er.execution_id
        JOIN execution_private.executions e ON e.tenant_id=er.tenant_id AND e.execution_id=er.execution_id
        WHERE er.tenant_id=tenant AND e.issuer=iss ORDER BY x.recorded_at DESC LIMIT 200) q;
    RETURN jsonb_build_object('status',200,'value',jsonb_build_object('reviews',items));
  ELSIF operation='review' THEN
    IF NOT 'trust.approve'=ANY(perms) THEN RETURN jsonb_build_object('status',403,'error','trust_permission_required'); END IF;
    IF (payload - 'executionId' - 'decision' - 'note') <> '{}'::jsonb
       OR coalesce(payload->>'executionId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(payload->>'decision','') NOT IN ('justified','unjustified')
       OR jsonb_typeof(payload->'note') IS DISTINCT FROM 'string' OR length(payload->>'note') NOT BETWEEN 1 AND 500
       OR payload->>'note' ~ '[[:cntrl:]]' THEN
      RETURN jsonb_build_object('status',400,'error','invalid_emergency_review');
    END IF;
    SELECT r2.* INTO r FROM execution_private.emergency_reviews r2
      JOIN execution_private.executions e ON e.tenant_id=r2.tenant_id AND e.execution_id=r2.execution_id
      WHERE r2.tenant_id=tenant AND r2.execution_id=(payload->>'executionId')::uuid AND e.issuer=iss FOR UPDATE OF r2;
    IF NOT FOUND THEN RETURN jsonb_build_object('status',404,'error','not_found'); END IF;
    IF r.state<>'pending' THEN RETURN jsonb_build_object('status',409,'error','already_reviewed'); END IF;
    UPDATE execution_private.emergency_reviews SET state=payload->>'decision', reviewer_subject=who, reviewer_client=client,
      note=payload->>'note', reviewed_at=clock_timestamp(), revision=revision+1
      WHERE tenant_id=tenant AND execution_id=r.execution_id RETURNING * INTO r;
    PERFORM app_private.audit_append('execution.emergency_reviewed','execution',r.execution_id,r.revision,
      CASE WHEN r.state='justified' THEN 'success' ELSE 'denied' END, r.state, payload->>'note');
    RETURN jsonb_build_object('status',200,'value',jsonb_build_object('executionId',r.execution_id,'state',r.state,
      'reviewedAt',to_char(r.reviewed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  END IF;
  RETURN jsonb_build_object('status',400,'error','invalid_operation');
END $$;

DO $do$ BEGIN
  IF to_regprocedure('app_private.application_management_command(text,jsonb)') IS NULL THEN
    ALTER FUNCTION core.application_command(text,jsonb) RENAME TO application_management_command;
    ALTER FUNCTION core.application_management_command(text,jsonb) SET SCHEMA app_private;
  END IF;
END $do$;
REVOKE ALL ON FUNCTION app_private.application_management_command(text,jsonb) FROM PUBLIC,junctura_app_api;

-- Reading one application: an audit.read principal sees any application of its
-- tenant (read-only); everything else, and every write, goes to the original command.
CREATE OR REPLACE FUNCTION core.application_command(operation text, payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  c jsonb; tenant text; who text; iss text; client text; perms text[]; a app_private.applications;
BEGIN
  IF operation='get' AND coalesce(payload->>'appId','') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    BEGIN c:=current_setting('request.jwt.claims',true)::jsonb;
    EXCEPTION WHEN others THEN c:=NULL; END;
    tenant:=c->>'tenant_id'; who:=c->>'sub'; iss:=c->>'iss'; client:=c->>'client_id';
    IF tenant ~ '^[a-z][a-z0-9-]{0,62}$' AND coalesce(who,'')<>'' AND coalesce(iss,'')<>'' AND coalesce(client,'')<>'' THEN
      SELECT p.permissions INTO perms FROM app_private.principals p
        WHERE p.tenant_id=tenant AND p.issuer=iss AND p.subject=who AND p.management_client=client AND p.enabled;
      IF 'audit.read'=ANY(perms) THEN
        SELECT * INTO a FROM app_private.applications
          WHERE tenant_id=tenant AND app_id=(payload->>'appId')::uuid AND issuer=iss;
        IF FOUND THEN RETURN jsonb_build_object('status',200,'value',app_private.application_view(a)); END IF;
      END IF;
    END IF;
  END IF;
  RETURN app_private.application_management_command(operation,payload);
END $$;

ALTER FUNCTION core.capability_command(text,jsonb) OWNER TO junctura_app_owner;
REVOKE ALL ON FUNCTION core.capability_command(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.capability_command(text,jsonb) TO junctura_capability_api;
ALTER FUNCTION core.emergency_review(text,jsonb) OWNER TO junctura_app_owner;
REVOKE ALL ON FUNCTION core.emergency_review(text,jsonb) FROM PUBLIC,junctura_api,junctura_app_api,junctura_resource_api,junctura_audit_api,junctura_subject_api,junctura_execution_api;
GRANT EXECUTE ON FUNCTION core.emergency_review(text,jsonb) TO junctura_trust_api;
ALTER FUNCTION app_private.application_management_command(text,jsonb) OWNER TO junctura_app_owner;
ALTER FUNCTION core.application_command(text,jsonb) OWNER TO junctura_app_owner;
REVOKE ALL ON FUNCTION core.application_command(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.application_command(text,jsonb) TO junctura_app_api;
INSERT INTO core.schema_migrations(version) VALUES(29);
NOTIFY pgrst,'reload schema';
COMMIT;
