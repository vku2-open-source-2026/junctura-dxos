-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
-- Catalog visibility levels. Every capability version carries one exposure
-- level for the tenant catalog: tenant (whole organization), units (named
-- units through token groups), applications (named caller applications) or
-- hidden (only exact grant discovery and management views, the previous
-- behavior). Existing and newly registered rows stay hidden: grant-based
-- discovery, publisher/auditor/owner views and cursors are unchanged, so
-- implemented authorized discovery keeps its contract. Management exposure
-- changes (visibility PUT) are audited with the chosen level.
BEGIN;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

ALTER TABLE app_private.capability_versions
  ADD COLUMN visibility text NOT NULL DEFAULT 'hidden'
    CHECK (visibility IN ('tenant','units','applications','hidden')),
  ADD COLUMN visibility_units text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(visibility_units)<=64),
  ADD COLUMN visibility_apps uuid[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(visibility_apps)<=64),
  ADD CONSTRAINT capability_visibility_units_scope
    CHECK ((visibility='units')=(cardinality(visibility_units)>0)),
  ADD CONSTRAINT capability_visibility_apps_scope
    CHECK ((visibility='applications')=(cardinality(visibility_apps)>0));

CREATE OR REPLACE FUNCTION app_private.capability_version_view(v app_private.capability_versions) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object(
    'versionId',v.version_id,'capabilityId',v.capability_id,'providerAppId',v.provider_app_id,
    'version',v.version,'manifest',v.manifest,'state',v.state,'revision',v.revision,'digest',v.digest,
    'visibility',v.visibility,'visibilityUnits',v.visibility_units,'visibilityApps',v.visibility_apps,
    'validation',CASE WHEN v.validation_status IS NULL THEN NULL ELSE jsonb_build_object(
      'status',v.validation_status,'digest',v.validation_digest,'revision',v.validation_revision,
      'policyRevision',v.validation_policy_revision,'report',v.validation_report,
      'validatedAt',v.validated_at) END,
    'createdBy',v.created_by,'updatedBy',v.updated_by,'createdAt',v.created_at,'updatedAt',v.updated_at,
    'publishedAt',v.published_at,'deprecatedAt',v.deprecated_at,'revokedAt',v.revoked_at)
$$;

-- Rebuild of migration 029 with three catalog additions:
--   1. operation 'visibility' sets the exposure level (publisher, or the
--      owning provider writer) behind an exact If-Match, audited;
--   2. tenant members (an enabled principal row) may list and read the
--      catalog and see exactly what visibility exposes to their token
--      context; previously they were refused outright;
--   3. get/list additionally return published versions exposed at the
--      tenant level, to a caller unit named in visibility_units, or to the
--      caller application named in visibility_apps.
CREATE OR REPLACE FUNCTION core.capability_command(operation text,payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  c jsonb:=current_setting('request.jwt.claims',true)::jsonb; perms text[]; who text:=c->>'sub';
  publisher boolean; management boolean; auditor boolean; tenant_member boolean;
  actor uuid; caller_app uuid; v app_private.capability_versions; owner_subject text;
  v_limit integer:=100; cursor_parts text[]; cursor_time timestamptz; cursor_id uuid; items jsonb; next_cursor text;
  v_units text[]; v_apps uuid[]; n integer; n_distinct integer;
BEGIN
  IF operation NOT IN ('get','list','visibility') THEN RETURN app_private.capability_management_command(operation,payload); END IF;
  SELECT permissions INTO perms FROM app_private.principals WHERE tenant_id=c->>'tenant_id' AND issuer=c->>'iss'
    AND subject=c->>'sub' AND management_client=c->>'client_id' AND enabled;
  publisher:=coalesce('capabilities.publish'=ANY(perms),false);
  management:=publisher OR coalesce('capabilities.write'=ANY(perms),false);
  auditor:=coalesce('audit.read'=ANY(perms),false);
  tenant_member:=perms IS NOT NULL;
  actor:=core.resource_actor();
  caller_app:=coalesce(nullif(c->>'human_app_id','')::uuid,core.resource_actor());
  IF NOT management AND NOT auditor AND actor IS NULL AND NOT tenant_member THEN
    RETURN jsonb_build_object('status',403,'error','capability_permission_required'); END IF;
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
    IF v.state='published' AND (v.visibility='tenant'
        OR (v.visibility='units' AND EXISTS (SELECT FROM unnest(v.visibility_units) AS u(unit_key) WHERE (c->'units') ? u.unit_key))
        OR (v.visibility='applications' AND caller_app IS NOT NULL AND caller_app=ANY(v.visibility_apps))) THEN
      RETURN jsonb_build_object('status',200,'value',trust_private.capability_view(v));
    END IF;
    RETURN jsonb_build_object('status',404,'error','not_found');
  END IF;
  IF operation='visibility' THEN
    IF jsonb_typeof(payload) IS DISTINCT FROM 'object'
      OR coalesce(payload->>'capabilityId','') !~ '^urn:junctura:capability:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[a-z][a-z0-9-]{0,62}$'
      OR coalesce(payload->>'version','') !~ '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$'
      OR EXISTS (SELECT FROM jsonb_object_keys(payload) k WHERE k NOT IN ('capabilityId','version','visibility','units','applications','etag'))
      OR jsonb_typeof(payload->'visibility') IS DISTINCT FROM 'string'
      OR payload->>'visibility' NOT IN ('tenant','units','applications','hidden')
      OR (payload->>'visibility'='units') IS DISTINCT FROM (payload ? 'units')
      OR (payload->>'visibility'='applications') IS DISTINCT FROM (payload ? 'applications') THEN
      RETURN jsonb_build_object('status',400,'error','invalid_capability_visibility');
    END IF;
    IF payload->>'visibility'='units' THEN
      IF jsonb_typeof(payload->'units')<>'array' THEN RETURN jsonb_build_object('status',400,'error','invalid_capability_visibility'); END IF;
      SELECT count(*),count(DISTINCT u.unit_key) INTO n,n_distinct FROM jsonb_array_elements_text(payload->'units') AS u(unit_key);
      IF n NOT BETWEEN 1 AND 64 OR n<>n_distinct
        OR EXISTS (SELECT FROM jsonb_array_elements_text(payload->'units') AS u(unit_key) WHERE u.unit_key !~ '^[a-z][a-z0-9-]{1,63}$') THEN
        RETURN jsonb_build_object('status',400,'error','invalid_capability_visibility');
      END IF;
      IF EXISTS (SELECT FROM jsonb_array_elements_text(payload->'units') AS u(unit_key) WHERE NOT EXISTS (
        SELECT FROM app_private.directory_units d WHERE d.tenant_id=c->>'tenant_id' AND d.unit=u.unit_key
          AND NOT d.pending_delete AND d.confirmed_value IS NOT NULL)) THEN
        RETURN jsonb_build_object('status',404,'error','not_found');
      END IF;
      SELECT array_agg(DISTINCT u.unit_key ORDER BY u.unit_key) INTO v_units FROM jsonb_array_elements_text(payload->'units') AS u(unit_key);
      v_apps:='{}'::uuid[];
    ELSIF payload->>'visibility'='applications' THEN
      IF jsonb_typeof(payload->'applications')<>'array' THEN RETURN jsonb_build_object('status',400,'error','invalid_capability_visibility'); END IF;
      SELECT count(*),count(DISTINCT a.app_key) INTO n,n_distinct FROM jsonb_array_elements_text(payload->'applications') AS a(app_key);
      IF n NOT BETWEEN 1 AND 64 OR n<>n_distinct
        OR EXISTS (SELECT FROM jsonb_array_elements_text(payload->'applications') AS a(app_key) WHERE a.app_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
        RETURN jsonb_build_object('status',400,'error','invalid_capability_visibility');
      END IF;
      IF EXISTS (SELECT FROM jsonb_array_elements_text(payload->'applications') AS a(app_key) WHERE NOT EXISTS (
        SELECT FROM app_private.applications d WHERE d.tenant_id=c->>'tenant_id' AND d.issuer=c->>'iss' AND d.app_id=a.app_key::uuid)) THEN
        RETURN jsonb_build_object('status',404,'error','not_found');
      END IF;
      SELECT array_agg(DISTINCT a.app_key::uuid ORDER BY a.app_key::uuid) INTO v_apps FROM jsonb_array_elements_text(payload->'applications') AS a(app_key);
      v_units:='{}'::text[];
    ELSE
      v_units:='{}'::text[]; v_apps:='{}'::uuid[];
    END IF;
    SELECT cv.* INTO v FROM app_private.capability_versions cv WHERE cv.tenant_id=c->>'tenant_id'
      AND cv.capability_id=payload->>'capabilityId' AND cv.version=payload->>'version' FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('status',404,'error','not_found'); END IF;
    SELECT a.owner_subject INTO owner_subject FROM app_private.applications a WHERE a.tenant_id=v.tenant_id AND a.app_id=v.provider_app_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('status',404,'error','not_found'); END IF;
    IF NOT (publisher OR (management AND owner_subject=c->>'sub')) THEN
      RETURN jsonb_build_object('status',403,'error','capability_permission_required'); END IF;
    IF payload->>'etag' IS NULL THEN RETURN jsonb_build_object('status',428,'error','if_match_required'); END IF;
    IF payload->>'etag'<>('"capability-version-'||v.version_id||'-'||v.revision||'"') THEN
      RETURN jsonb_build_object('status',412,'error','revision_mismatch');
    END IF;
    -- Exposure is registry metadata, not published content: the revision and
    -- its validation/approval bindings stay untouched, so the recorded
    -- validation invariant (validation_revision=revision-1) keeps holding.
    UPDATE app_private.capability_versions SET visibility=payload->>'visibility',visibility_units=v_units,
      visibility_apps=v_apps,updated_by=who,updated_at=now()
      WHERE tenant_id=c->>'tenant_id' AND version_id=v.version_id RETURNING * INTO v;
    PERFORM app_private.audit_append('capability.visibility_changed','capability',v.version_id,v.revision,
      'success',payload->>'visibility',NULL);
    RETURN jsonb_build_object('status',200,'value',app_private.capability_version_view(v));
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
      -- Tenant members page like management callers: their view is
      -- recomputed from the current visibility per page, and they carry no
      -- backend actor to bind a consumer cursor to.
      IF management OR auditor OR tenant_member THEN
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
      WHERE cv.tenant_id=c->>'tenant_id' AND (publisher OR auditor OR (management AND app.owner_subject=c->>'sub') OR trust_private.granted(cv,'discover')
          OR (cv.state='published' AND (cv.visibility='tenant'
            OR (cv.visibility='units' AND EXISTS (SELECT FROM unnest(cv.visibility_units) AS u(unit_key) WHERE (c->'units') ? u.unit_key))
            OR (cv.visibility='applications' AND caller_app IS NOT NULL AND caller_app=ANY(cv.visibility_apps)))))
        AND (cursor_time IS NULL OR (cv.updated_at,cv.version_id)<(cursor_time,cursor_id))
      ORDER BY cv.updated_at DESC,cv.version_id DESC LIMIT v_limit+1
    ) a;
  IF jsonb_array_length(items)>v_limit THEN
    next_cursor:=encode(convert_to(CASE WHEN management OR auditor OR tenant_member THEN '' ELSE (c->>'tenant_id')||'|'||actor::text||'|' END ||
      (items->(v_limit-1)->>'updatedAt')||'|'||(items->(v_limit-1)->>'versionId'),'UTF8'),'hex');
    items:=items-v_limit;
  END IF;
  RETURN jsonb_build_object('status',200,'value',jsonb_build_object('items',items,'nextCursor',next_cursor));
END $$;

ALTER FUNCTION core.capability_command(text,jsonb) OWNER TO junctura_app_owner;
REVOKE ALL ON FUNCTION core.capability_command(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.capability_command(text,jsonb) TO junctura_capability_api;
RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES(60) ON CONFLICT DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
