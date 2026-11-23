-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='junctura_search_worker') THEN
    CREATE ROLE junctura_search_worker NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT junctura_search_worker TO junctura_data;
GRANT USAGE ON SCHEMA core TO junctura_search_worker;
SET LOCAL ROLE junctura_app_owner;

CREATE TABLE app_private.search_index_jobs (
  tenant_id text NOT NULL,
  job_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  resource_type text NOT NULL CHECK(resource_type IN ('record','object')),
  resource_id uuid NOT NULL,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX search_jobs_tenant_idx ON app_private.search_index_jobs (tenant_id, job_id);

CREATE TABLE app_private.search_generations (
  tenant_id text PRIMARY KEY,
  generation uuid,
  building_generation uuid,
  retired_generation uuid,
  rebuild_requested boolean NOT NULL DEFAULT false,
  ready_at timestamptz
);

CREATE TABLE app_private.search_worker_leases (
  tenant_id text PRIMARY KEY CHECK (tenant_id ~ '^[a-z][a-z0-9-]{0,62}$'),
  holder uuid NOT NULL,
  expires_at timestamptz NOT NULL
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['search_index_jobs','search_generations','search_worker_leases'] LOOP
    EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app_private.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON app_private.%I TO junctura_app_owner
      USING (tenant_id=nullif(current_setting(''request.jwt.claims'',true),'''')::jsonb->>''tenant_id'')', t);
    EXECUTE format('REVOKE ALL ON app_private.%I FROM PUBLIC', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['search_index_jobs','search_generations'] LOOP
    EXECUTE format('CREATE POLICY worker_discovery ON app_private.%I FOR SELECT TO junctura_app_owner
      USING (current_setting(''request.jwt.claims'',true)::jsonb->>''role''=''junctura_search_worker''
        AND current_setting(''request.jwt.claims'',true)::jsonb->>''tenant_id'' IS NULL)', t);
  END LOOP;
END $$;

-- The source row determines the tenant even for writes by an operator.
CREATE FUNCTION app_private.search_enqueue() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private AS $$
DECLARE
  tenant text := coalesce(NEW.tenant_id, OLD.tenant_id);
  previous text := current_setting('request.jwt.claims',true);
BEGIN
  PERFORM set_config('request.jwt.claims',jsonb_build_object('tenant_id',tenant)::text,true);
  IF TG_TABLE_NAME='record_collections' THEN
    INSERT INTO search_index_jobs(tenant_id,resource_type,resource_id)
      SELECT tenant,'record',r.id FROM core.app_records r
      WHERE r.tenant_id=tenant AND r.owner_app_id=NEW.owner_app_id AND r.collection=NEW.collection;
  ELSE
    INSERT INTO search_index_jobs(tenant_id,resource_type,resource_id)
      VALUES (tenant,TG_ARGV[0],coalesce(NEW.id,OLD.id));
  END IF;
  PERFORM set_config('request.jwt.claims',coalesce(previous,''),true);
  RETURN NULL;
END $$;
CREATE TRIGGER search_records_enqueue AFTER INSERT OR UPDATE OR DELETE ON core.app_records
  FOR EACH ROW EXECUTE FUNCTION app_private.search_enqueue('record');
CREATE TRIGGER search_objects_insert AFTER INSERT ON app_private.resource_objects
  FOR EACH ROW WHEN (NEW.version IS NOT NULL) EXECUTE FUNCTION app_private.search_enqueue('object');
CREATE TRIGGER search_objects_update AFTER UPDATE ON app_private.resource_objects
  FOR EACH ROW WHEN (OLD.version IS DISTINCT FROM NEW.version OR OLD.deleted IS DISTINCT FROM NEW.deleted)
  EXECUTE FUNCTION app_private.search_enqueue('object');
CREATE TRIGGER search_objects_delete AFTER DELETE ON app_private.resource_objects
  FOR EACH ROW WHEN (OLD.version IS NOT NULL) EXECUTE FUNCTION app_private.search_enqueue('object');
CREATE TRIGGER search_schema_enqueue AFTER UPDATE ON app_private.record_collections
  FOR EACH ROW WHEN (OLD.schema_revision IS DISTINCT FROM NEW.schema_revision)
  EXECUTE FUNCTION app_private.search_enqueue();

CREATE FUNCTION core.search_command(operation text, payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private,pg_temp
SET lock_timeout='2s' SET timezone='UTC' AS $$
DECLARE
  claims jsonb := nullif(current_setting('request.jwt.claims', true),'')::jsonb;
  tenant text := claims->>'tenant_id';
  worker boolean := claims->>'role' IS NOT DISTINCT FROM 'junctura_search_worker';
  items jsonb;
  state search_generations;
  lease uuid;
  lease_expiry timestamptz;
  actor uuid;
BEGIN
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN
    RETURN record_error(400,'invalid_request');
  END IF;
  IF operation IN ('tenants','acquire','renew','release','prepare','finish','retire','jobs','drop','document') THEN
    IF NOT worker THEN RETURN record_error(403,'worker_required'); END IF;
  ELSIF worker OR nullif(claims->>'iss','') IS NULL OR nullif(claims->>'sub','') IS NULL
    OR nullif(claims->>'client_id','') IS NULL THEN
    RETURN record_error(403,'verified_client_required');
  END IF;

  IF operation='tenants' THEN
    IF tenant IS NOT NULL OR payload <> '{}'::jsonb THEN RETURN record_error(403,'worker_required'); END IF;
    SELECT coalesce(jsonb_agg(t.tenant_id ORDER BY t.tenant_id),'[]'::jsonb) INTO items FROM (
      SELECT j.tenant_id FROM search_index_jobs j UNION SELECT g.tenant_id FROM search_generations g
    ) t;
    RETURN jsonb_build_object('status',200,'value',items);
  END IF;
  IF tenant IS NULL OR tenant !~ '^[a-z][a-z0-9-]{0,62}$' THEN
    RETURN record_error(403,'verified_client_required');
  END IF;

  IF worker THEN
    IF coalesce(payload->>'lease','') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN
      RETURN record_error(403,'worker_required');
    END IF;
    lease:=(payload->>'lease')::uuid;
    IF operation='acquire' THEN
      INSERT INTO search_worker_leases(tenant_id,holder,expires_at)
        VALUES (tenant,lease,clock_timestamp()+interval '60 seconds')
        ON CONFLICT (tenant_id) DO UPDATE SET holder=EXCLUDED.holder,expires_at=clock_timestamp()+interval '60 seconds'
        WHERE search_worker_leases.expires_at<=clock_timestamp();
      IF NOT FOUND THEN RETURN record_error(409,'search_lease_busy'); END IF;
      INSERT INTO search_generations(tenant_id) VALUES (tenant) ON CONFLICT DO NOTHING;
      SELECT g.* INTO state FROM search_generations g WHERE g.tenant_id=tenant;
      RETURN jsonb_build_object('status',200,'value',to_jsonb(state));
    END IF;
    IF operation='release' THEN
      DELETE FROM search_worker_leases l WHERE l.tenant_id=tenant AND l.holder=lease;
      RETURN jsonb_build_object('status',200,'value',true);
    END IF;

    -- Lock the lease through the commit of each queue mutation.
    SELECT l.expires_at INTO lease_expiry FROM search_worker_leases l
      WHERE l.tenant_id=tenant AND l.holder=lease FOR UPDATE;
    IF NOT FOUND OR lease_expiry<=clock_timestamp() THEN RETURN record_error(409,'search_lease_lost'); END IF;
    IF operation='renew' THEN
      UPDATE search_worker_leases l SET expires_at=clock_timestamp()+interval '60 seconds' WHERE l.tenant_id=tenant;
      RETURN jsonb_build_object('status',200,'value',true);
    END IF;

    IF operation='prepare' THEN
      UPDATE search_generations g SET building_generation=gen_random_uuid(),rebuild_requested=false
        WHERE g.tenant_id=tenant RETURNING g.* INTO state;
      INSERT INTO search_index_jobs(tenant_id,resource_type,resource_id)
        SELECT r.tenant_id,'record',r.id FROM core.app_records r
        JOIN record_collections c USING (tenant_id,owner_app_id,collection)
        WHERE r.tenant_id=tenant AND cardinality(c.searchable_fields)>0
        UNION ALL
        SELECT o.tenant_id,'object',o.id FROM resource_objects o
        WHERE o.tenant_id=tenant AND NOT o.deleted AND o.version IS NOT NULL;
      RETURN jsonb_build_object('status',200,'value',to_jsonb(state));
    END IF;
    IF operation='finish' THEN
      UPDATE search_generations g SET generation=g.building_generation,building_generation=NULL,
        retired_generation=g.generation,ready_at=clock_timestamp()
        WHERE g.tenant_id=tenant AND g.building_generation IS NOT NULL AND g.retired_generation IS NULL
          AND NOT EXISTS (SELECT FROM search_index_jobs j WHERE j.tenant_id=tenant)
        RETURNING g.* INTO state;
      RETURN jsonb_build_object('status',200,'value',CASE WHEN FOUND THEN to_jsonb(state) END);
    END IF;
    IF operation='retire' THEN
      IF payload->>'generation' IS NOT NULL AND payload->>'generation'
        !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RETURN record_error(400,'invalid_request');
      END IF;
      UPDATE search_generations g SET retired_generation=NULL
        WHERE g.tenant_id=tenant AND g.retired_generation=(payload->>'generation')::uuid;
      RETURN jsonb_build_object('status',200,'value',true);
    END IF;

    IF operation='jobs' THEN
      SELECT coalesce(jsonb_agg(jsonb_build_object('jobId',j.job_id::text,'kind',j.resource_type,'id',j.resource_id)
        ORDER BY j.job_id),'[]'::jsonb) INTO items
      FROM (SELECT * FROM search_index_jobs j WHERE j.tenant_id=tenant AND j.available_at<=clock_timestamp()
        ORDER BY j.job_id LIMIT 32) j;
      RETURN jsonb_build_object('status',200,'value',items);
    END IF;
    IF operation='drop' THEN
      IF (payload ? 'jobIds' AND jsonb_typeof(payload->'jobIds') IS DISTINCT FROM 'array')
        OR (payload ? 'retryJobIds' AND jsonb_typeof(payload->'retryJobIds') IS DISTINCT FROM 'array')
        OR jsonb_array_length(coalesce(payload->'jobIds','[]'::jsonb))>1000
        OR jsonb_array_length(coalesce(payload->'retryJobIds','[]'::jsonb))>1000 THEN
        RETURN record_error(400,'invalid_request');
      END IF;
      DELETE FROM search_index_jobs j WHERE j.tenant_id=tenant AND
        j.job_id IN (SELECT value::bigint FROM jsonb_array_elements_text(payload->'jobIds'));
      UPDATE search_index_jobs j SET available_at=clock_timestamp()+interval '5 seconds'
        WHERE j.tenant_id=tenant AND
          j.job_id IN (SELECT value::bigint FROM jsonb_array_elements_text(payload->'retryJobIds'));
      RETURN jsonb_build_object('status',200,'value',true);
    END IF;

    IF operation='document' THEN
      IF payload->>'kind'='record' THEN
        SELECT jsonb_build_object('id',r.id,'ownerAppId',r.owner_app_id,'collection',r.collection,
          'version',r.version::text,'incarnation',r.incarnation,'schemaRevision',c.schema_revision::text,
          'searchable',c.searchable_fields,'sensitive',c.sensitive_fields,'data',r.data)
        INTO items FROM core.app_records r JOIN record_collections c USING (tenant_id,owner_app_id,collection)
        WHERE r.tenant_id=tenant AND r.id=(payload->>'id')::uuid AND cardinality(c.searchable_fields)>0;
      ELSIF payload->>'kind'='object' THEN
        SELECT jsonb_build_object('id',o.id,'ownerAppId',o.owner_app_id,'version',o.version)
        INTO items FROM resource_objects o WHERE o.tenant_id=tenant AND o.id=(payload->>'id')::uuid
          AND NOT o.deleted AND o.version IS NOT NULL;
      END IF;
      RETURN jsonb_build_object('status',200,'value',items);
    END IF;
  END IF;

  SELECT g.* INTO state FROM search_generations g WHERE g.tenant_id=tenant;
  IF operation='scope' THEN
    actor:=core.resource_actor();
    SELECT jsonb_build_object('generation',state.generation,'actor',actor,
      'management',ARRAY(SELECT DISTINCT g.owner_app_id FROM record_read_grants g
        WHERE g.tenant_id=tenant AND g.issuer=claims->>'iss' AND g.subject=claims->>'sub'
          AND g.management_client=claims->>'client_id' AND g.owner_app_id IS DISTINCT FROM actor
          AND record_management_read(g.owner_app_id) ORDER BY g.owner_app_id),
      'shares',ARRAY(SELECT DISTINCT s.resource_type || '-' || s.owner_app_id || '-' || s.resource_id AS key
        FROM resource_shares s WHERE actor IS NOT NULL AND s.tenant_id=tenant
          AND s.owner_app_id<>actor AND NOT s.revoked AND s.expires_at>now()
          AND core.resource_readable(s.owner_app_id,s.resource_type,s.resource_id) ORDER BY key))
    INTO items;
    RETURN jsonb_build_object('status',200,'value',items);
  END IF;

  IF operation='acl' THEN
    IF jsonb_typeof(payload->'candidates') IS DISTINCT FROM 'array'
      OR jsonb_array_length(payload->'candidates')>100 THEN RETURN record_error(400,'invalid_request'); END IF;
    -- Each candidate answers with its own position, so two hits naming the
    -- same resource id (a rejected projection or a stale version still in the
    -- index) can never decide visibility for each other.
    SELECT coalesce(jsonb_agg(jsonb_build_object('position',position,'item',item) ORDER BY position),'[]'::jsonb)
      INTO items
    FROM (
      SELECT c.position,
        CASE
          WHEN c.kind='record' AND r.version=c.version::bigint AND r.incarnation=c.incarnation
            AND cs.schema_revision=c."schemaRevision"::bigint AND cardinality(cs.searchable_fields)>0
            AND c.projection=CASE record_read_scope(r.owner_app_id,r.id)
              WHEN 'management' THEN 'management' WHEN 'owner' THEN 'full' WHEN 'shared' THEN 'full' END
            THEN jsonb_build_object('type','record','recordRef',jsonb_build_object('collection',r.collection,'id',r.id))
          WHEN c.kind='object' AND o.version=c.version::uuid AND c.projection='full'
            AND (o.owner_app_id=core.resource_actor() OR core.resource_readable(o.owner_app_id,'object',o.id))
            THEN jsonb_build_object('type','object','objectId',o.id)
        END AS item
      FROM jsonb_to_recordset(payload->'candidates')
        AS c(kind text,id uuid,"ownerAppId" uuid,version text,incarnation uuid,"schemaRevision" text,projection text,position integer)
      LEFT JOIN core.app_records r ON c.kind='record' AND r.tenant_id=tenant AND r.id=c.id AND r.owner_app_id=c."ownerAppId"
      LEFT JOIN record_collections cs ON cs.tenant_id=r.tenant_id AND cs.owner_app_id=r.owner_app_id AND cs.collection=r.collection
      LEFT JOIN resource_objects o ON c.kind='object' AND o.tenant_id=tenant AND o.id=c.id AND o.owner_app_id=c."ownerAppId" AND NOT o.deleted
    ) approved
    WHERE item IS NOT NULL;
    RETURN jsonb_build_object('status',200,'value',jsonb_build_object('items',items,'generation',state.generation));
  END IF;

  RETURN record_error(400,'invalid_operation');
END $$;

REVOKE ALL ON FUNCTION app_private.search_enqueue(),core.search_command(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.search_command(text,jsonb) TO junctura_resource_api,junctura_search_worker;

RESET ROLE;
-- Discover tenants with existing data before the first worker sweep.
INSERT INTO app_private.search_generations(tenant_id)
  SELECT r.tenant_id FROM core.app_records r
  UNION SELECT o.tenant_id FROM app_private.resource_objects o WHERE NOT o.deleted AND o.version IS NOT NULL;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (44);
NOTIFY pgrst, 'reload schema';
COMMIT;
