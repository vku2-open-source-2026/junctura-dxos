-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

CREATE TABLE trust_private.access_requests (
  tenant_id text NOT NULL,
  request_id uuid NOT NULL DEFAULT gen_random_uuid(),
  issuer text NOT NULL,
  consumer_app_id uuid NOT NULL,
  provider_app_id uuid NOT NULL,
  version_id uuid NOT NULL,
  capability_id text NOT NULL,
  version text NOT NULL,
  manifest_digest text NOT NULL,
  purpose text NOT NULL CHECK (length(purpose) BETWEEN 1 AND 512),
  idempotency_key uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','withdrawn','declined','accepted')),
  reason text CHECK (length(reason) BETWEEN 1 AND 512),
  grant_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,request_id),
  UNIQUE (tenant_id,issuer,consumer_app_id,idempotency_key),
  FOREIGN KEY (tenant_id,consumer_app_id) REFERENCES app_private.applications(tenant_id,app_id),
  FOREIGN KEY (tenant_id,provider_app_id) REFERENCES app_private.applications(tenant_id,app_id),
  FOREIGN KEY (tenant_id,version_id) REFERENCES app_private.capability_versions(tenant_id,version_id),
  FOREIGN KEY (tenant_id,grant_id) REFERENCES trust_private.grants(tenant_id,grant_id),
  CHECK (provider_app_id<>consumer_app_id),
  CHECK ((state='declined')=(reason IS NOT NULL)),
  CHECK ((state='accepted')=(grant_id IS NOT NULL))
);
ALTER TABLE trust_private.access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_private.access_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON trust_private.access_requests TO junctura_app_owner
  USING (tenant_id=app_private.record_tenant()) WITH CHECK (tenant_id=app_private.record_tenant());
CREATE INDEX access_requests_consumer_page ON trust_private.access_requests
  (tenant_id,issuer,consumer_app_id,created_at DESC,request_id DESC);
CREATE INDEX access_requests_provider_page ON trust_private.access_requests
  (tenant_id,issuer,provider_app_id,created_at DESC,request_id DESC);
CREATE INDEX access_requests_catalog ON trust_private.access_requests
  (tenant_id,issuer,consumer_app_id,version_id) WHERE state IN ('pending','accepted');

CREATE FUNCTION trust_private.access_request_view(r trust_private.access_requests) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('requestId',r.request_id,'providerAppId',r.provider_app_id,'consumerAppId',r.consumer_app_id,
    'capabilityId',r.capability_id,'version',r.version,'manifestDigest',r.manifest_digest,'purpose',r.purpose,
    'state',r.state,'reason',r.reason,'grantId',r.grant_id,'createdAt',r.created_at,'updatedAt',r.updated_at)
$$;

-- The published exposure rules from 060 also control which targets can receive requests.
CREATE FUNCTION app_private.capability_exposed(v app_private.capability_versions,c jsonb,caller_app uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT v.state='published' AND (v.visibility='tenant'
    OR (v.visibility='units' AND EXISTS (SELECT FROM unnest(v.visibility_units) u(unit_key) WHERE (c->'units') ? u.unit_key))
    OR (v.visibility='applications' AND caller_app IS NOT NULL AND caller_app=ANY(v.visibility_apps)))
$$;

CREATE FUNCTION core.capability_catalog(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app_private,pg_temp SET timezone='UTC' AS $$
DECLARE
  c jsonb:=current_setting('request.jwt.claims',true)::jsonb;
  tenant text:=record_tenant(); actor uuid:=core.resource_actor();
  caller_app uuid:=coalesce(nullif(c->>'human_app_id','')::uuid,actor);
  perms text[]; wide_view boolean; own_view boolean;
  page_size integer:=coalesce((payload->>'limit')::integer,100);
  scope text; parts text[]; cursor_time timestamptz; cursor_id uuid; items jsonb; next_cursor text;
BEGIN
  SELECT permissions INTO perms FROM principals WHERE tenant_id=tenant AND issuer=c->>'iss'
    AND subject=c->>'sub' AND management_client=c->>'client_id' AND enabled;
  IF perms IS NULL AND actor IS NULL THEN RETURN record_error(403,'capability_permission_required'); END IF;
  wide_view:=coalesce(perms && ARRAY['capabilities.publish','audit.read'],false);
  own_view:=coalesce('capabilities.write'=ANY(perms),false);
  IF page_size NOT BETWEEN 1 AND 100 THEN RETURN record_error(400,'invalid_capability_query'); END IF;
  scope:=encode(sha256(convert_to(jsonb_build_array('catalog',tenant,encode(record_caller_scope(actor),'hex'),
    c->'units')::text,'UTF8')),'hex');
  IF payload ? 'cursor' THEN
    BEGIN
      parts:=string_to_array(convert_from(decode(payload->>'cursor','hex'),'UTF8'),'|');
      IF cardinality(parts) IS DISTINCT FROM 3 OR parts[1] IS DISTINCT FROM scope THEN
        RETURN record_error(400,'invalid_capability_cursor');
      END IF;
      cursor_time:=parts[2]::timestamptz; cursor_id:=parts[3]::uuid;
    EXCEPTION WHEN data_exception THEN RETURN record_error(400,'invalid_capability_cursor'); END;
  END IF;

  WITH candidates AS (
    SELECT cv, trust_private.granted(cv,'discover') AS discover,
      wide_view OR (own_view AND a.owner_subject=c->>'sub') OR capability_exposed(cv,c,caller_app) AS exposed
    FROM capability_versions cv JOIN applications a
      ON (a.tenant_id,a.app_id)=(cv.tenant_id,cv.provider_app_id) AND a.issuer=c->>'iss'
    WHERE cv.tenant_id=tenant AND cv.state='published'
  ), latest AS (
    SELECT DISTINCT ON ((cv).capability_id) cv, discover
    FROM candidates WHERE exposed OR discover
    ORDER BY (cv).capability_id,string_to_array((cv).version,'.')::integer[] DESC
  ), page AS (
    SELECT cv, discover FROM latest
    WHERE cursor_time IS NULL OR ((cv).published_at,(cv).version_id)<(cursor_time,cursor_id)
    ORDER BY (cv).published_at DESC,(cv).version_id DESC LIMIT page_size+1
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('capabilityId',(cv).capability_id,'versionId',(cv).version_id,
    'providerAppId',(cv).provider_app_id,'version',(cv).version,'digest',(cv).digest,'state',(cv).state,
    'visibility',(cv).visibility,'title',(cv).manifest->'title','description',(cv).manifest->'description',
    'publishedAt',(cv).published_at,'myAccess',CASE
      WHEN discover OR trust_private.granted(cv,'invoke') THEN 'granted'
      WHEN EXISTS (SELECT FROM trust_private.access_requests r
        WHERE (r.tenant_id,r.issuer,r.consumer_app_id,r.version_id,r.manifest_digest)=
          (tenant,c->>'iss',actor,(cv).version_id,(cv).digest)
          AND (r.state='pending' OR (r.state='accepted' AND EXISTS (
            SELECT FROM trust_private.grants g WHERE (g.tenant_id,g.grant_id)=(r.tenant_id,r.grant_id)
              AND g.state='pending' AND g.expires_at>statement_timestamp())))) THEN 'requested'
      ELSE 'none' END)
    || CASE WHEN discover THEN jsonb_build_object('manifest',(cv).manifest) ELSE '{}'::jsonb END
    ORDER BY (cv).published_at DESC,(cv).version_id DESC),'[]'::jsonb) INTO items FROM page;
  IF jsonb_array_length(items)>page_size THEN
    next_cursor:=encode(convert_to(scope||'|'||(items->(page_size-1)->>'publishedAt')||'|'||
      (items->(page_size-1)->>'versionId'),'UTF8'),'hex');
    items:=items-page_size;
  END IF;
  RETURN jsonb_build_object('status',200,'value',jsonb_build_object('items',items,'nextCursor',next_cursor));
END $$;

-- Grant proposals use ASCII keys, plus JSON strings, booleans, arrays and objects.
-- Serialize in the same key order and without the whitespace used by jsonb::text.
CREATE FUNCTION trust_private.grant_canonical_json(value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT CASE jsonb_typeof(value)
    WHEN 'object' THEN '{'||coalesce((SELECT string_agg(to_jsonb(k)::text||':'||
      trust_private.grant_canonical_json(v),',' ORDER BY k COLLATE "C") FROM jsonb_each(value) e(k,v)),'')||'}'
    WHEN 'array' THEN '['||coalesce((SELECT string_agg(trust_private.grant_canonical_json(v),',' ORDER BY n)
      FROM jsonb_array_elements(value) WITH ORDINALITY e(v,n)),'')||']'
    ELSE value::text END
$$;

CREATE FUNCTION core.capability_access_request_command(operation text,payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private,pg_temp SET timezone='UTC' AS $$
DECLARE
  c jsonb:=current_setting('request.jwt.claims',true)::jsonb;
  tenant text:=record_tenant(); iss text:=c->>'iss'; who text:=c->>'sub';
  actor uuid; provider_writer boolean; sender boolean; recipient boolean;
  r trust_private.access_requests; v capability_versions; provider applications;
  write_allowed boolean:=coalesce(c->'trust_writer'='true'::jsonb,false);
  page_size integer:=coalesce((payload->>'limit')::integer,100);
  direction text:=payload->>'direction'; state_filter text:=payload->>'state';
  scope text; parts text[]; cursor_time timestamptz; cursor_id uuid; items jsonb; next_cursor text;
  request_key uuid; proposed_grant_id uuid; proposal jsonb; result jsonb; consumer_subject text; event_name text;
BEGIN
  IF c->>'human_app_id' IS NULL THEN actor:=core.resource_actor(); END IF;
  SELECT EXISTS (SELECT FROM principals WHERE tenant_id=tenant AND issuer=iss AND subject=who
    AND management_client=c->>'client_id' AND enabled AND 'trust.write'=ANY(permissions)) INTO provider_writer;
  IF operation NOT IN ('create','list','get','withdraw','decline','accept') THEN
    RETURN record_error(400,'invalid_operation');
  END IF;
  IF operation NOT IN ('list','get') AND NOT write_allowed THEN RETURN record_error(403,'write_forbidden'); END IF;

  IF operation='create' THEN
    IF actor IS NULL THEN RETURN record_error(403,'application_access_required'); END IF;
    request_key:=(payload->>'idempotencyKey')::uuid;
    PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('capability_access_request',
      tenant,iss,actor,request_key)::text,0));
    SELECT * INTO r FROM trust_private.access_requests x
      WHERE (x.tenant_id,x.issuer,x.consumer_app_id,x.idempotency_key)=(tenant,iss,actor,request_key);
    IF FOUND THEN
      IF (r.capability_id,r.version,r.purpose) IS DISTINCT FROM
        (payload->>'capabilityId',payload->>'version',payload->>'purpose') THEN
        RETURN record_error(409,'idempotency_conflict');
      END IF;
      RETURN jsonb_build_object('status',200,'value',trust_private.access_request_view(r));
    END IF;
    SELECT cv.* INTO v FROM capability_versions cv JOIN applications a
      ON (a.tenant_id,a.app_id)=(cv.tenant_id,cv.provider_app_id)
      JOIN enrollments e ON (e.tenant_id,e.issuer,e.oauth_client_id,e.owner_subject,e.provider_origin)=
        (a.tenant_id,a.issuer,a.oauth_client_id,a.owner_subject,a.provider_origin)
      WHERE cv.tenant_id=tenant AND a.issuer=iss AND a.state='active' AND e.enabled AND cv.capability_id=payload->>'capabilityId'
        AND cv.version=payload->>'version' AND cv.state='published'
        AND (capability_exposed(cv,c,actor) OR trust_private.granted(cv,'discover'))
      FOR SHARE OF cv;
    IF NOT FOUND THEN RETURN record_error(404,'not_found'); END IF;
    IF actor=v.provider_app_id THEN RETURN record_error(409,'same_application'); END IF;
    INSERT INTO trust_private.access_requests(tenant_id,issuer,consumer_app_id,provider_app_id,version_id,
      capability_id,version,manifest_digest,purpose,idempotency_key)
      VALUES(tenant,iss,actor,v.provider_app_id,v.version_id,v.capability_id,v.version,v.digest,payload->>'purpose',request_key)
      RETURNING * INTO r;
    PERFORM audit_append('capability.access_request_created','capability',r.request_id,1);
    RETURN jsonb_build_object('status',201,'value',trust_private.access_request_view(r));
  END IF;

  IF operation='list' THEN
    IF actor IS NULL AND NOT provider_writer THEN RETURN record_error(403,'access_request_permission_required'); END IF;
    IF page_size NOT BETWEEN 1 AND 100 THEN RETURN record_error(400,'invalid_access_request_query'); END IF;
    scope:=encode(sha256(convert_to(jsonb_build_array('access_requests',tenant,encode(record_caller_scope(actor),'hex'),
      direction,state_filter)::text,'UTF8')),'hex');
    IF payload ? 'cursor' THEN
      BEGIN
        parts:=string_to_array(convert_from(decode(payload->>'cursor','hex'),'UTF8'),'|');
        IF cardinality(parts) IS DISTINCT FROM 3 OR parts[1] IS DISTINCT FROM scope THEN
          RETURN record_error(400,'invalid_access_request_cursor');
        END IF;
        cursor_time:=parts[2]::timestamptz; cursor_id:=parts[3]::uuid;
      EXCEPTION WHEN data_exception THEN RETURN record_error(400,'invalid_access_request_cursor'); END;
    END IF;
    SELECT coalesce(jsonb_agg(trust_private.access_request_view(page.r)
      ORDER BY (page.r).created_at DESC,(page.r).request_id DESC),'[]'::jsonb) INTO items FROM (
      SELECT x AS r FROM trust_private.access_requests x JOIN applications a
        ON (a.tenant_id,a.issuer,a.app_id)=(x.tenant_id,x.issuer,x.provider_app_id)
      WHERE x.tenant_id=tenant AND x.issuer=iss
        AND ((direction IS DISTINCT FROM 'incoming' AND x.consumer_app_id=actor)
          OR (direction IS DISTINCT FROM 'outgoing' AND provider_writer AND a.owner_subject=who))
        AND (state_filter IS NULL OR x.state=state_filter)
        AND (cursor_time IS NULL OR (x.created_at,x.request_id)<(cursor_time,cursor_id))
      ORDER BY x.created_at DESC,x.request_id DESC LIMIT page_size+1
    ) page;
    IF jsonb_array_length(items)>page_size THEN
      next_cursor:=encode(convert_to(scope||'|'||(items->(page_size-1)->>'createdAt')||'|'||
        (items->(page_size-1)->>'requestId'),'UTF8'),'hex');
      items:=items-page_size;
    END IF;
    RETURN jsonb_build_object('status',200,'value',jsonb_build_object('items',items,'nextCursor',next_cursor));
  END IF;

  SELECT x.* INTO r FROM trust_private.access_requests x JOIN applications a
    ON (a.tenant_id,a.issuer,a.app_id)=(x.tenant_id,x.issuer,x.provider_app_id)
    WHERE (x.tenant_id,x.issuer,x.request_id)=(tenant,iss,(payload->>'requestId')::uuid)
      AND (x.consumer_app_id=actor OR (provider_writer AND a.owner_subject=who)) FOR UPDATE OF x;
  IF NOT FOUND THEN RETURN record_error(404,'not_found'); END IF;
  IF operation='get' THEN RETURN jsonb_build_object('status',200,'value',trust_private.access_request_view(r)); END IF;

  SELECT * INTO provider FROM applications WHERE (tenant_id,issuer,app_id)=(tenant,iss,r.provider_app_id);
  sender:=actor IS NOT NULL AND r.consumer_app_id=actor;
  recipient:=provider_writer AND provider.owner_subject=who;
  IF (operation='withdraw' AND NOT sender) OR (operation IN ('decline','accept') AND NOT recipient) THEN
    RETURN record_error(403,'access_request_permission_required');
  END IF;
  IF r.state<>'pending' THEN RETURN record_error(409,'invalid_transition'); END IF;
  IF operation='accept' THEN
    SELECT * INTO v FROM capability_versions WHERE (tenant_id,version_id)=(tenant,r.version_id);
    SELECT e.resource_subject INTO consumer_subject FROM applications a JOIN enrollments e
      USING (tenant_id,issuer,oauth_client_id,owner_subject,provider_origin)
      WHERE (a.tenant_id,a.issuer,a.app_id)=(tenant,iss,r.consumer_app_id);
    IF v.state<>'published' OR v.digest<>r.manifest_digest THEN RETURN record_error(409,'capability_not_available'); END IF;
    proposed_grant_id:=gen_random_uuid();
    proposal:=jsonb_build_object('providerAppId',r.provider_app_id,'consumerAppId',r.consumer_app_id,
      'capabilities',jsonb_build_array(jsonb_build_object('capabilityId',r.capability_id,'version',r.version,
        'manifestDigest',r.manifest_digest)),
      'operations',jsonb_build_array('discover','invoke'),'permissions',v.manifest->'requiredPermissions',
      'subjectIds',jsonb_build_array(consumer_subject),'delegationAllowed',false,'acceptDelegation',false,
      'expiresAt',to_char(clock_timestamp()+interval '30 days','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    result:=core.trust_command('create',jsonb_build_object('grantId',proposed_grant_id,'proposal',proposal,
      'digest','sha256:'||encode(sha256(convert_to(trust_private.grant_canonical_json(jsonb_build_object(
        'grantId',proposed_grant_id,'tenantId',tenant,'issuer',iss,'createdBy',who,'proposal',proposal)),'UTF8')),'hex')));
    IF result ? 'error' THEN RETURN result; END IF;
    r.state:='accepted';
  ELSIF operation='decline' THEN
    r.state:='declined';
    r.reason:=payload->>'reason';
  ELSE
    r.state:='withdrawn';
  END IF;
  UPDATE trust_private.access_requests SET state=r.state,reason=r.reason,grant_id=proposed_grant_id,updated_at=clock_timestamp()
    WHERE (tenant_id,request_id)=(r.tenant_id,r.request_id) RETURNING * INTO r;
  event_name:='capability.access_request_'||r.state;
  PERFORM audit_append(event_name,'capability',r.request_id,2,'success',NULL,r.reason);
  RETURN jsonb_build_object('status',200,'value',trust_private.access_request_view(r));
END $$;

REVOKE ALL ON FUNCTION app_private.capability_exposed(app_private.capability_versions,jsonb,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION trust_private.access_request_view(trust_private.access_requests) FROM PUBLIC;
REVOKE ALL ON FUNCTION trust_private.grant_canonical_json(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION core.capability_catalog(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION core.capability_access_request_command(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.capability_catalog(jsonb) TO junctura_capability_api;
GRANT EXECUTE ON FUNCTION core.capability_access_request_command(text,jsonb) TO junctura_trust_api;
RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES(61);
NOTIFY pgrst,'reload schema';
COMMIT;
