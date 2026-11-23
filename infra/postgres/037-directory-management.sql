-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
-- Directory desired state and tenant leases shared by Core replicas.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='junctura_directory_api') THEN
    CREATE ROLE junctura_directory_api NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='junctura_directory_worker') THEN
    CREATE ROLE junctura_directory_worker NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT junctura_directory_api, junctura_directory_worker TO junctura_data;
GRANT USAGE ON SCHEMA core TO junctura_directory_api, junctura_directory_worker;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

ALTER TABLE app_private.principals DROP CONSTRAINT IF EXISTS principals_permissions_check;
ALTER TABLE app_private.principals ADD CONSTRAINT principals_permissions_check
  CHECK (permissions <@ ARRAY['applications.register','applications.approve','trust.write','trust.approve','audit.read',
    'capabilities.write','capabilities.publish','capabilities.approve',
    'compositions.write','compositions.publish','compositions.approve','directory.write']::text[]);

CREATE TABLE IF NOT EXISTS app_private.directory_unit_types (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z][a-z0-9-]{0,62}$'),
  unit_type text COLLATE "C" NOT NULL CHECK (unit_type ~ '^[a-z][a-z0-9-]{1,63}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120 AND name !~ '[[:cntrl:]]'),
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  synced_generation bigint,
  pending_delete boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, unit_type)
);
CREATE TABLE IF NOT EXISTS app_private.directory_units (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z][a-z0-9-]{0,62}$'),
  unit text COLLATE "C" NOT NULL CHECK (unit ~ '^[a-z][a-z0-9-]{1,63}$'),
  unit_type text COLLATE "C" NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120 AND name !~ '[[:cntrl:]]'),
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  synced_generation bigint,
  confirmed_value jsonb,
  pending_delete boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, unit),
  FOREIGN KEY (tenant_id, unit_type) REFERENCES app_private.directory_unit_types (tenant_id, unit_type)
);
CREATE TABLE IF NOT EXISTS app_private.directory_groups (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z][a-z0-9-]{0,62}$'),
  unit text COLLATE "C" NOT NULL,
  unit_group text COLLATE "C" NOT NULL CHECK (unit_group ~ '^[a-z][a-z0-9-]{1,63}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120 AND name !~ '[[:cntrl:]]'),
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  synced_generation bigint,
  confirmed_value jsonb,
  pending_delete boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, unit, unit_group),
  FOREIGN KEY (tenant_id, unit) REFERENCES app_private.directory_units (tenant_id, unit)
);
CREATE TABLE IF NOT EXISTS app_private.directory_members (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z][a-z0-9-]{0,62}$'),
  unit text COLLATE "C" NOT NULL,
  subject text COLLATE "C" NOT NULL CHECK (subject ~ '^[A-Za-z0-9:_-]{1,128}$'),
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  synced_generation bigint,
  confirmed_value jsonb,
  pending_delete boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, unit, subject),
  FOREIGN KEY (tenant_id, unit) REFERENCES app_private.directory_units (tenant_id, unit)
);
CREATE TABLE IF NOT EXISTS app_private.directory_memberships (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z][a-z0-9-]{0,62}$'),
  unit text COLLATE "C" NOT NULL,
  subject text COLLATE "C" NOT NULL,
  unit_group text COLLATE "C" NOT NULL,
  PRIMARY KEY (tenant_id, unit, subject, unit_group),
  FOREIGN KEY (tenant_id, unit, subject) REFERENCES app_private.directory_members (tenant_id, unit, subject) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, unit, unit_group) REFERENCES app_private.directory_groups (tenant_id, unit, unit_group)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['directory_unit_types','directory_units','directory_groups','directory_members','directory_memberships'] LOOP
    EXECUTE format('ALTER TABLE app_private.%I OWNER TO junctura_app_owner', t);
    EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app_private.%I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT FROM pg_policies WHERE schemaname='app_private' AND tablename=t AND policyname='record_tenant_isolation') THEN
      EXECUTE format('CREATE POLICY record_tenant_isolation ON app_private.%I TO junctura_app_owner USING (tenant_id=(current_setting(''request.jwt.claims'',true)::jsonb->>''tenant_id'')) WITH CHECK (tenant_id=(current_setting(''request.jwt.claims'',true)::jsonb->>''tenant_id''))', t);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON app_private.directory_unit_types, app_private.directory_units,
  app_private.directory_groups, app_private.directory_members, app_private.directory_memberships FROM PUBLIC;

-- Tenant discovery exposes only lease keys to the internal worker. Directory
-- rows and all lease mutations still require a tenant-scoped JWT.
CREATE TABLE app_private.directory_sync_leases (
  tenant_id text PRIMARY KEY CHECK (tenant_id ~ '^[a-z][a-z0-9-]{0,62}$'),
  holder uuid NOT NULL,
  expires_at timestamptz NOT NULL
);
ALTER TABLE app_private.directory_sync_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.directory_sync_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY directory_lease_tenant ON app_private.directory_sync_leases TO junctura_app_owner
  USING (tenant_id = current_setting('request.jwt.claims',true)::jsonb->>'tenant_id')
  WITH CHECK (tenant_id = current_setting('request.jwt.claims',true)::jsonb->>'tenant_id');
CREATE POLICY directory_lease_discovery ON app_private.directory_sync_leases FOR SELECT TO junctura_app_owner
  USING (current_setting('request.jwt.claims',true)::jsonb->>'role' = 'junctura_directory_worker');
REVOKE ALL ON app_private.directory_sync_leases FROM PUBLIC;

-- A management caller needs directory.write and mutations need core-writer.
-- A worker can acquire a lease, read desired state and confirm provider jobs.
CREATE OR REPLACE FUNCTION core.directory_command(operation text, payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  c jsonb; tenant text; who text; iss text; client text;
  key text; unit_key text; desired_name text; desired_type text; gen bigint; prior text; synced bigint; pending boolean;
  worker boolean; lease_id uuid; member_exists boolean; job jsonb;
  created boolean; desired text[]; current_groups text[]; items jsonb; total bigint;
  max_items constant bigint := 100;
BEGIN
  BEGIN c:=current_setting('request.jwt.claims',true)::jsonb;
  EXCEPTION WHEN others THEN c:=NULL; END;
  tenant:=c->>'tenant_id'; who:=c->>'sub'; iss:=c->>'iss'; client:=c->>'client_id';
  worker:=coalesce(c->>'role'='junctura_directory_worker',false);
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('status',400,'error','invalid_request');
  END IF;
  IF worker AND operation='sync_tenants' THEN
    SELECT coalesce(jsonb_agg(l.tenant_id ORDER BY l.tenant_id),'[]'::jsonb) INTO items
      FROM (SELECT tenant_id FROM app_private.directory_sync_leases
            WHERE tenant_id > coalesce(payload->>'after','') ORDER BY tenant_id LIMIT 100) l;
    RETURN jsonb_build_object('status',200,'value',items);
  END IF;
  IF tenant IS NULL OR tenant !~ '^[a-z][a-z0-9-]{0,62}$' THEN
    RETURN jsonb_build_object('status',403,'error','forbidden');
  END IF;
  IF worker THEN
    IF operation NOT IN ('sync_acquire','sync_renew','sync_release','sync_next',
      'unit_confirm','unit_delete_confirm','group_confirm','group_delete_confirm','member_confirm','member_delete_confirm') THEN
      RETURN jsonb_build_object('status',403,'error','forbidden');
    END IF;
  ELSE
    PERFORM 1 FROM app_private.principals p
      WHERE p.tenant_id=tenant AND p.issuer=iss AND p.subject=who
        AND p.management_client=client AND p.enabled AND 'directory.write'=ANY(p.permissions);
    IF NOT FOUND THEN RETURN jsonb_build_object('status',403,'error','forbidden'); END IF;
    IF operation NOT IN ('unit_type_list','unit_list','group_list','member_list')
       AND coalesce(c->>'directory_writer','') IS DISTINCT FROM 'true' THEN
      RETURN jsonb_build_object('status',403,'error','write_forbidden');
    END IF;
    IF operation='sync_next' THEN RETURN jsonb_build_object('status',403,'error','forbidden'); END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('junctura-directory:'||tenant,0));
  IF operation NOT IN ('unit_type_put','unit_type_delete','unit_type_list','unit_list','group_list','member_list') THEN
    IF coalesce(payload->>'lease','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN jsonb_build_object('status',400,'error','invalid_request');
    END IF;
    lease_id:=(payload->>'lease')::uuid;
    payload:=payload-'lease';
    IF operation='sync_acquire' THEN
      INSERT INTO app_private.directory_sync_leases AS l (tenant_id, holder, expires_at)
        VALUES (tenant, lease_id, clock_timestamp()+interval '30 seconds')
        ON CONFLICT (tenant_id) DO UPDATE SET holder=EXCLUDED.holder, expires_at=EXCLUDED.expires_at
          WHERE l.expires_at<=clock_timestamp();
      IF NOT FOUND THEN RETURN jsonb_build_object('status',409,'error','resource_conflict'); END IF;
      RETURN jsonb_build_object('status',204);
    ELSIF operation='sync_release' THEN
      UPDATE app_private.directory_sync_leases SET expires_at='-infinity'
        WHERE tenant_id=tenant AND holder=lease_id;
      RETURN jsonb_build_object('status',204);
    END IF;
    PERFORM 1 FROM app_private.directory_sync_leases
      WHERE tenant_id=tenant AND holder=lease_id AND expires_at>clock_timestamp();
    IF NOT FOUND THEN RETURN jsonb_build_object('status',409,'error','resource_conflict'); END IF;
    IF operation='sync_renew' THEN
      UPDATE app_private.directory_sync_leases SET expires_at=clock_timestamp()+interval '30 seconds'
        WHERE tenant_id=tenant AND holder=lease_id;
      RETURN jsonb_build_object('status',204);
    END IF;
  END IF;

  CASE operation
  WHEN 'sync_next' THEN
    -- Create parents first and delete children first. Scan confirmed rows and
    -- tombstones too because an expired worker's HTTP write can finish late.
    SELECT jsonb_build_object('cursor',jsonb_build_array(d.phase,d.unit,d.key),
      'kind',d.kind,'remove',d.remove,'generation',d.generation,'keys',d.keys,'groups',d.groups)
      INTO job
    FROM (
      SELECT CASE WHEN u.pending_delete THEN 6 ELSE 1 END AS phase, u.unit, ''::text COLLATE "C" AS key,
        'unit' AS kind, u.pending_delete AS remove, u.generation, jsonb_build_object('unit',u.unit) AS keys, NULL::jsonb AS groups
        FROM app_private.directory_units u WHERE u.tenant_id=tenant
      UNION ALL
      SELECT CASE WHEN g.pending_delete THEN 5 ELSE 2 END, g.unit, g.unit_group, 'group', g.pending_delete,
        g.generation, jsonb_build_object('unit',g.unit,'group',g.unit_group), NULL
        FROM app_private.directory_groups g WHERE g.tenant_id=tenant
      UNION ALL
      SELECT CASE WHEN m.pending_delete THEN 4 ELSE 3 END, m.unit, m.subject, 'member', m.pending_delete,
        m.generation, jsonb_build_object('unit',m.unit,'subject',m.subject),
        (SELECT coalesce(jsonb_agg(g.unit_group ORDER BY g.unit_group),'[]'::jsonb)
         FROM app_private.directory_memberships g WHERE (g.tenant_id,g.unit,g.subject)=(m.tenant_id,m.unit,m.subject))
        FROM app_private.directory_members m WHERE m.tenant_id=tenant
    ) d
    WHERE (d.phase, d.unit, d.key) >
      (coalesce((payload->'after'->>0)::int,0),coalesce(payload->'after'->>1,''),coalesce(payload->'after'->>2,''))
    ORDER BY d.phase,d.unit,d.key LIMIT 1;
    RETURN jsonb_build_object('status',200,'value',job);
  WHEN 'unit_type_put' THEN
    IF (payload - 'unitType' - 'name') <> '{}'::jsonb OR coalesce(payload->>'unitType','') !~ '^[a-z][a-z0-9-]{1,63}$'
       OR jsonb_typeof(payload->'name') IS DISTINCT FROM 'string'
       OR length(payload->>'name') NOT BETWEEN 1 AND 120 OR payload->>'name' ~ '[[:cntrl:]]' THEN
      RETURN jsonb_build_object('status',400,'error','invalid_request');
    END IF;
    key:=payload->>'unitType'; desired_name:=payload->>'name';
    SELECT generation, synced_generation, name, pending_delete INTO gen, synced, prior, pending FROM app_private.directory_unit_types
      WHERE tenant_id=tenant AND unit_type=key FOR UPDATE;
    IF FOUND AND NOT pending AND prior=desired_name THEN
      RETURN jsonb_build_object('status',200);
    END IF;
    IF NOT FOUND THEN
      INSERT INTO app_private.directory_unit_types(tenant_id,unit_type,name,generation,synced_generation) VALUES(tenant,key,desired_name,1,1);
      gen:=1; created:=true;
    ELSE
      created:=pending AND synced=gen;
      UPDATE app_private.directory_unit_types SET name=desired_name, generation=generation+1, synced_generation=generation+1,
        pending_delete=false, updated_at=clock_timestamp() WHERE tenant_id=tenant AND unit_type=key RETURNING generation INTO gen;
    END IF;
    RETURN jsonb_build_object('status',CASE WHEN created THEN 201 ELSE 200 END);
  WHEN 'unit_type_delete' THEN
    IF (payload - 'unitType') <> '{}'::jsonb OR coalesce(payload->>'unitType','') !~ '^[a-z][a-z0-9-]{1,63}$' THEN
      RETURN jsonb_build_object('status',400,'error','invalid_request');
    END IF;
    SELECT generation, pending_delete, synced_generation INTO gen, pending, synced FROM app_private.directory_unit_types
      WHERE tenant_id=tenant AND unit_type=payload->>'unitType' FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('status',204); END IF;
    IF EXISTS (SELECT 1 FROM app_private.directory_units u WHERE u.tenant_id=tenant AND ((u.unit_type=payload->>'unitType' AND NOT u.pending_delete)
        OR u.confirmed_value->>'unitType'=payload->>'unitType')) THEN
      RETURN jsonb_build_object('status',409,'error','resource_conflict');
    END IF;
    IF pending AND synced=gen THEN RETURN jsonb_build_object('status',204); END IF;
    IF NOT pending THEN
      UPDATE app_private.directory_unit_types SET pending_delete=true, generation=generation+1, synced_generation=generation+1,
        updated_at=clock_timestamp() WHERE tenant_id=tenant AND unit_type=payload->>'unitType' RETURNING generation INTO gen;
    END IF;
    RETURN jsonb_build_object('status',204);
  WHEN 'unit_put' THEN
    IF (payload - 'unit' - 'unitType' - 'name') <> '{}'::jsonb OR coalesce(payload->>'unit','') !~ '^[a-z][a-z0-9-]{1,63}$'
       OR coalesce(payload->>'unitType','') !~ '^[a-z][a-z0-9-]{1,63}$'
       OR jsonb_typeof(payload->'name') IS DISTINCT FROM 'string'
       OR length(payload->>'name') NOT BETWEEN 1 AND 120 OR payload->>'name' ~ '[[:cntrl:]]' THEN
      RETURN jsonb_build_object('status',400,'error','invalid_request');
    END IF;
    unit_key:=payload->>'unit'; key:=payload->>'unitType'; desired_name:=payload->>'name';
    IF NOT EXISTS (SELECT 1 FROM app_private.directory_unit_types t WHERE t.tenant_id=tenant AND t.unit_type=key AND NOT t.pending_delete) THEN
      RETURN jsonb_build_object('status',404,'error','not_found');
    END IF;
    SELECT generation, synced_generation, name, unit_type, pending_delete INTO gen, synced, prior, desired_type, pending FROM app_private.directory_units
      WHERE tenant_id=tenant AND unit=unit_key FOR UPDATE;
    IF FOUND AND NOT pending AND synced=gen AND prior=desired_name AND desired_type=key THEN
      RETURN jsonb_build_object('status',200,'generation',to_jsonb(gen),'confirmed',true);
    END IF;
    IF FOUND AND NOT pending AND prior=desired_name AND desired_type=key THEN
      RETURN jsonb_build_object('status',200,'generation',to_jsonb(gen));
    END IF;
    IF NOT FOUND THEN
      INSERT INTO app_private.directory_units(tenant_id,unit,unit_type,name,generation) VALUES(tenant,unit_key,key,desired_name,1);
      gen:=1; created:=true;
    ELSE
      created:=pending AND synced=gen;
      UPDATE app_private.directory_units SET unit_type=key, name=desired_name, generation=generation+1, synced_generation=NULL,
        pending_delete=false, updated_at=clock_timestamp() WHERE tenant_id=tenant AND unit=unit_key RETURNING generation INTO gen;
    END IF;
    RETURN jsonb_build_object('status',CASE WHEN created THEN 201 ELSE 200 END,'generation',to_jsonb(gen));
  WHEN 'unit_confirm' THEN
    IF (payload - 'unit' - 'generation') <> '{}'::jsonb OR coalesce(payload->>'unit','') !~ '^[a-z][a-z0-9-]{1,63}$'
       OR jsonb_typeof(payload->'generation') IS DISTINCT FROM 'number'
       OR payload->>'generation' !~ '^[0-9]{1,16}$' THEN
      RETURN jsonb_build_object('status',400,'error','invalid_request');
    END IF;
    UPDATE app_private.directory_units SET synced_generation=(payload->>'generation')::bigint, confirmed_value=jsonb_build_object('unit',unit,'unitType',unit_type,'name',name), updated_at=clock_timestamp()
      WHERE tenant_id=tenant AND unit=payload->>'unit' AND generation=(payload->>'generation')::bigint AND NOT pending_delete;
    IF NOT FOUND THEN RETURN jsonb_build_object('status',409,'error','resource_conflict'); END IF;
    RETURN jsonb_build_object('status',204);
  WHEN 'unit_delete' THEN
    IF (payload - 'unit') <> '{}'::jsonb OR coalesce(payload->>'unit','') !~ '^[a-z][a-z0-9-]{1,63}$' THEN
      RETURN jsonb_build_object('status',400,'error','invalid_request');
    END IF;
    unit_key:=payload->>'unit';
    SELECT generation, pending_delete, synced_generation INTO gen, pending, synced FROM app_private.directory_units WHERE tenant_id=tenant AND unit=unit_key FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('status',204); END IF;
    IF EXISTS (SELECT 1 FROM app_private.directory_groups g WHERE g.tenant_id=tenant AND g.unit=unit_key AND (NOT g.pending_delete OR g.confirmed_value IS NOT NULL))
       OR EXISTS (SELECT 1 FROM app_private.directory_members m WHERE m.tenant_id=tenant AND m.unit=unit_key AND (NOT m.pending_delete OR m.confirmed_value IS NOT NULL)) THEN
      RETURN jsonb_build_object('status',409,'error','resource_conflict');
    END IF;
    IF NOT pending THEN
      UPDATE app_private.directory_units SET pending_delete=true, generation=generation+1, synced_generation=NULL,
        updated_at=clock_timestamp() WHERE tenant_id=tenant AND unit=unit_key RETURNING generation INTO gen;
    END IF;
    RETURN jsonb_build_object('status',204,'generation',to_jsonb(gen));
  WHEN 'unit_delete_confirm' THEN
    IF (payload - 'unit' - 'generation') <> '{}'::jsonb OR coalesce(payload->>'unit','') !~ '^[a-z][a-z0-9-]{1,63}$'
       OR jsonb_typeof(payload->'generation') IS DISTINCT FROM 'number'
       OR payload->>'generation' !~ '^[0-9]{1,16}$' THEN
      RETURN jsonb_build_object('status',400,'error','invalid_request');
    END IF;
    UPDATE app_private.directory_units SET synced_generation=(payload->>'generation')::bigint, confirmed_value=NULL, updated_at=clock_timestamp()
      WHERE tenant_id=tenant AND unit=payload->>'unit'
      AND generation=(payload->>'generation')::bigint AND pending_delete;
    IF NOT FOUND THEN RETURN jsonb_build_object('status',409,'error','resource_conflict'); END IF;
    RETURN jsonb_build_object('status',204);
  WHEN 'group_put' THEN
    IF (payload - 'unit' - 'group' - 'name') <> '{}'::jsonb OR coalesce(payload->>'unit','') !~ '^[a-z][a-z0-9-]{1,63}$'
       OR coalesce(payload->>'group','') !~ '^[a-z][a-z0-9-]{1,63}$'
       OR jsonb_typeof(payload->'name') IS DISTINCT FROM 'string'
       OR length(payload->>'name') NOT BETWEEN 1 AND 120 OR payload->>'name' ~ '[[:cntrl:]]' THEN
      RETURN jsonb_build_object('status',400,'error','invalid_request');
    END IF;
    unit_key:=payload->>'unit'; key:=payload->>'group'; desired_name:=payload->>'name';
    IF NOT EXISTS (SELECT 1 FROM app_private.directory_units u WHERE u.tenant_id=tenant AND u.unit=unit_key AND NOT u.pending_delete) THEN
      RETURN jsonb_build_object('status',404,'error','not_found');
    END IF;
    SELECT generation, synced_generation, name, pending_delete INTO gen, synced, prior, pending FROM app_private.directory_groups
      WHERE tenant_id=tenant AND unit=unit_key AND unit_group=key FOR UPDATE;
    IF FOUND AND NOT pending AND synced=gen AND prior=desired_name THEN
      RETURN jsonb_build_object('status',200,'generation',to_jsonb(gen),'confirmed',true);
    END IF;
    IF FOUND AND NOT pending AND prior=desired_name THEN
      RETURN jsonb_build_object('status',200,'generation',to_jsonb(gen));
    END IF;
    IF NOT FOUND THEN
      INSERT INTO app_private.directory_groups(tenant_id,unit,unit_group,name,generation) VALUES(tenant,unit_key,key,desired_name,1);
      gen:=1; created:=true;
    ELSE
      created:=pending AND synced=gen;
      UPDATE app_private.directory_groups SET name=desired_name, generation=generation+1, synced_generation=NULL,
        pending_delete=false, updated_at=clock_timestamp() WHERE tenant_id=tenant AND unit=unit_key AND unit_group=key RETURNING generation INTO gen;
    END IF;
    RETURN jsonb_build_object('status',CASE WHEN created THEN 201 ELSE 200 END,'generation',to_jsonb(gen));
  WHEN 'group_confirm' THEN
    IF (payload - 'unit' - 'group' - 'generation') <> '{}'::jsonb OR coalesce(payload->>'unit','') !~ '^[a-z][a-z0-9-]{1,63}$'
       OR coalesce(payload->>'group','') !~ '^[a-z][a-z0-9-]{1,63}$'
       OR jsonb_typeof(payload->'generation') IS DISTINCT FROM 'number'
       OR payload->>'generation' !~ '^[0-9]{1,16}$' THEN
      RETURN jsonb_build_object('status',400,'error','invalid_request');
    END IF;
    UPDATE app_private.directory_groups SET synced_generation=(payload->>'generation')::bigint, confirmed_value=jsonb_build_object('unit',unit,'group',unit_group,'name',name), updated_at=clock_timestamp()
      WHERE tenant_id=tenant AND unit=payload->>'unit' AND unit_group=payload->>'group' AND generation=(payload->>'generation')::bigint AND NOT pending_delete;
    IF NOT FOUND THEN RETURN jsonb_build_object('status',409,'error','resource_conflict'); END IF;
    RETURN jsonb_build_object('status',204);
  WHEN 'group_delete' THEN
    IF (payload - 'unit' - 'group') <> '{}'::jsonb OR coalesce(payload->>'unit','') !~ '^[a-z][a-z0-9-]{1,63}$'
       OR coalesce(payload->>'group','') !~ '^[a-z][a-z0-9-]{1,63}$' THEN
      RETURN jsonb_build_object('status',400,'error','invalid_request');
    END IF;
    unit_key:=payload->>'unit'; key:=payload->>'group';
    SELECT generation, pending_delete, synced_generation INTO gen, pending, synced FROM app_private.directory_groups
      WHERE tenant_id=tenant AND unit=unit_key AND unit_group=key FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('status',204); END IF;
    IF EXISTS (SELECT 1 FROM app_private.directory_memberships m WHERE m.tenant_id=tenant AND m.unit=unit_key AND m.unit_group=key)
       OR EXISTS (SELECT FROM app_private.directory_members m WHERE m.tenant_id=tenant AND m.unit=unit_key
                  AND (m.confirmed_value->'groups') ? key) THEN
      RETURN jsonb_build_object('status',409,'error','resource_conflict');
    END IF;
    IF NOT pending THEN
      UPDATE app_private.directory_groups SET pending_delete=true, generation=generation+1, synced_generation=NULL,
        updated_at=clock_timestamp() WHERE tenant_id=tenant AND unit=unit_key AND unit_group=key RETURNING generation INTO gen;
    END IF;
    RETURN jsonb_build_object('status',204,'generation',to_jsonb(gen));
  WHEN 'group_delete_confirm' THEN
    IF (payload - 'unit' - 'group' - 'generation') <> '{}'::jsonb OR coalesce(payload->>'unit','') !~ '^[a-z][a-z0-9-]{1,63}$'
       OR coalesce(payload->>'group','') !~ '^[a-z][a-z0-9-]{1,63}$'
       OR jsonb_typeof(payload->'generation') IS DISTINCT FROM 'number'
       OR payload->>'generation' !~ '^[0-9]{1,16}$' THEN
      RETURN jsonb_build_object('status',400,'error','invalid_request');
    END IF;
    UPDATE app_private.directory_groups SET synced_generation=(payload->>'generation')::bigint, confirmed_value=NULL, updated_at=clock_timestamp()
      WHERE tenant_id=tenant AND unit=payload->>'unit' AND unit_group=payload->>'group'
      AND generation=(payload->>'generation')::bigint AND pending_delete;
    IF NOT FOUND THEN RETURN jsonb_build_object('status',409,'error','resource_conflict'); END IF;
    RETURN jsonb_build_object('status',204);
  WHEN 'member_put' THEN
    IF (payload - 'unit' - 'subject' - 'groups') <> '{}'::jsonb OR coalesce(payload->>'unit','') !~ '^[a-z][a-z0-9-]{1,63}$'
       OR coalesce(payload->>'subject','') !~ '^[A-Za-z0-9:_-]{1,128}$'
       OR jsonb_typeof(payload->'groups') IS DISTINCT FROM 'array'
       OR jsonb_array_length(payload->'groups') > 100
       OR EXISTS (SELECT FROM jsonb_array_elements(payload->'groups') g WHERE jsonb_typeof(g)<>'string' OR g#>>'{}' !~ '^[a-z][a-z0-9-]{1,63}$') THEN
      RETURN jsonb_build_object('status',400,'error','invalid_request');
    END IF;
    unit_key:=payload->>'unit'; key:=payload->>'subject';
    IF NOT EXISTS (SELECT 1 FROM app_private.directory_units u WHERE u.tenant_id=tenant AND u.unit=unit_key AND NOT u.pending_delete) THEN
      RETURN jsonb_build_object('status',404,'error','not_found');
    END IF;
    SELECT array_agg(DISTINCT g ORDER BY g) INTO desired FROM jsonb_array_elements_text(payload->'groups') g;
    IF desired IS NOT NULL AND EXISTS (
      SELECT 1 FROM unnest(desired) g WHERE NOT EXISTS (
        SELECT 1 FROM app_private.directory_groups d WHERE d.tenant_id=tenant AND d.unit=unit_key AND d.unit_group=g AND NOT d.pending_delete)) THEN
      RETURN jsonb_build_object('status',404,'error','not_found');
    END IF;
    SELECT generation, synced_generation, pending_delete INTO gen, synced, pending FROM app_private.directory_members
      WHERE tenant_id=tenant AND unit=unit_key AND subject=key FOR UPDATE;
    member_exists := FOUND;
    created := NOT member_exists OR (pending AND synced=gen);
    SELECT coalesce(array_agg(m.unit_group ORDER BY m.unit_group),'{}'::text[]) INTO current_groups
      FROM app_private.directory_memberships m WHERE m.tenant_id=tenant AND m.unit=unit_key AND m.subject=key;
    IF member_exists AND NOT pending AND synced=gen AND current_groups IS NOT DISTINCT FROM coalesce(desired,'{}'::text[]) THEN
      RETURN jsonb_build_object('status',200,'generation',to_jsonb(gen),'confirmed',true);
    END IF;
    IF member_exists AND NOT pending AND current_groups IS NOT DISTINCT FROM coalesce(desired,'{}'::text[]) THEN
      RETURN jsonb_build_object('status',200,'generation',to_jsonb(gen));
    END IF;
    IF NOT member_exists THEN
      INSERT INTO app_private.directory_members(tenant_id,unit,subject,generation) VALUES(tenant,unit_key,key,1);
      gen:=1;
    ELSE
      UPDATE app_private.directory_members SET generation=generation+1, synced_generation=NULL, pending_delete=false, updated_at=clock_timestamp()
        WHERE tenant_id=tenant AND unit=unit_key AND subject=key RETURNING generation INTO gen;
    END IF;
    DELETE FROM app_private.directory_memberships WHERE tenant_id=tenant AND unit=unit_key AND subject=key;
    INSERT INTO app_private.directory_memberships(tenant_id,unit,subject,unit_group)
      SELECT tenant,unit_key,key,g FROM unnest(coalesce(desired,'{}'::text[])) g;
    RETURN jsonb_build_object('status',CASE WHEN created THEN 201 ELSE 200 END,'generation',to_jsonb(gen));
  WHEN 'member_confirm' THEN
    IF (payload - 'unit' - 'subject' - 'generation') <> '{}'::jsonb OR coalesce(payload->>'unit','') !~ '^[a-z][a-z0-9-]{1,63}$'
       OR coalesce(payload->>'subject','') !~ '^[A-Za-z0-9:_-]{1,128}$'
       OR jsonb_typeof(payload->'generation') IS DISTINCT FROM 'number'
       OR payload->>'generation' !~ '^[0-9]{1,16}$' THEN
      RETURN jsonb_build_object('status',400,'error','invalid_request');
    END IF;
    UPDATE app_private.directory_members d SET synced_generation=(payload->>'generation')::bigint, confirmed_value=jsonb_build_object('unit',d.unit,'subject',d.subject,'groups',
        (SELECT coalesce(jsonb_agg(g.unit_group ORDER BY g.unit_group),'[]'::jsonb)
         FROM app_private.directory_memberships g WHERE (g.tenant_id,g.unit,g.subject)=(d.tenant_id,d.unit,d.subject))), updated_at=clock_timestamp()
      WHERE tenant_id=tenant AND unit=payload->>'unit' AND subject=payload->>'subject' AND generation=(payload->>'generation')::bigint AND NOT pending_delete;
    IF NOT FOUND THEN RETURN jsonb_build_object('status',409,'error','resource_conflict'); END IF;
    RETURN jsonb_build_object('status',204);
  WHEN 'member_delete' THEN
    IF (payload - 'unit' - 'subject') <> '{}'::jsonb OR coalesce(payload->>'unit','') !~ '^[a-z][a-z0-9-]{1,63}$'
       OR coalesce(payload->>'subject','') !~ '^[A-Za-z0-9:_-]{1,128}$' THEN
      RETURN jsonb_build_object('status',400,'error','invalid_request');
    END IF;
    SELECT generation, pending_delete, synced_generation INTO gen, pending, synced FROM app_private.directory_members
      WHERE tenant_id=tenant AND unit=payload->>'unit' AND subject=payload->>'subject' FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('status',204); END IF;
    IF NOT pending THEN
      UPDATE app_private.directory_members SET pending_delete=true, generation=generation+1, synced_generation=NULL,
        updated_at=clock_timestamp() WHERE tenant_id=tenant AND unit=payload->>'unit' AND subject=payload->>'subject'
        RETURNING generation INTO gen;
      -- The memberships die with the deletion decision, so a unit or group
      -- delete is never blocked by a member that is already being removed.
      DELETE FROM app_private.directory_memberships WHERE tenant_id=tenant AND unit=payload->>'unit' AND subject=payload->>'subject';
    END IF;
    RETURN jsonb_build_object('status',204,'generation',to_jsonb(gen));
  WHEN 'member_delete_confirm' THEN
    IF (payload - 'unit' - 'subject' - 'generation') <> '{}'::jsonb OR coalesce(payload->>'unit','') !~ '^[a-z][a-z0-9-]{1,63}$'
       OR coalesce(payload->>'subject','') !~ '^[A-Za-z0-9:_-]{1,128}$'
       OR jsonb_typeof(payload->'generation') IS DISTINCT FROM 'number'
       OR payload->>'generation' !~ '^[0-9]{1,16}$' THEN
      RETURN jsonb_build_object('status',400,'error','invalid_request');
    END IF;
    UPDATE app_private.directory_members SET synced_generation=(payload->>'generation')::bigint, confirmed_value=NULL, updated_at=clock_timestamp()
      WHERE tenant_id=tenant AND unit=payload->>'unit' AND subject=payload->>'subject'
      AND generation=(payload->>'generation')::bigint AND pending_delete;
    IF NOT FOUND THEN RETURN jsonb_build_object('status',409,'error','resource_conflict'); END IF;
    RETURN jsonb_build_object('status',204);
  WHEN 'unit_type_list' THEN
    IF (payload - 'after' - 'limit') <> '{}'::jsonb OR jsonb_typeof(payload->'limit') IS DISTINCT FROM 'number'
       OR payload->>'limit' !~ '^[0-9]{1,3}$'
       OR (payload ? 'after' AND (jsonb_typeof(payload->'after') IS DISTINCT FROM 'string'
           OR payload->>'after' !~ '^[a-z][a-z0-9-]{1,63}$')) THEN
      RETURN jsonb_build_object('status',400,'error','invalid_request');
    END IF;
    SELECT count(*) INTO total FROM app_private.directory_unit_types WHERE tenant_id=tenant AND NOT pending_delete
      AND (payload ? 'after' AND unit_type > payload->>'after' OR NOT payload ? 'after');
    SELECT coalesce(jsonb_agg(jsonb_build_object('unitType',l.unit_type,'name',l.name) ORDER BY l.unit_type),'[]'::jsonb) INTO items
      FROM (SELECT * FROM app_private.directory_unit_types WHERE tenant_id=tenant AND NOT pending_delete
        AND (payload ? 'after' AND unit_type > payload->>'after' OR NOT payload ? 'after')
        ORDER BY unit_type LIMIT least(GREATEST((payload->>'limit')::bigint,1), max_items)) l;
    RETURN jsonb_build_object('status',200,'value',jsonb_build_object('items',items,'total',total));
  WHEN 'unit_list' THEN
    IF (payload - 'after' - 'limit') <> '{}'::jsonb OR jsonb_typeof(payload->'limit') IS DISTINCT FROM 'number'
       OR payload->>'limit' !~ '^[0-9]{1,3}$'
       OR (payload ? 'after' AND (jsonb_typeof(payload->'after') IS DISTINCT FROM 'string'
           OR payload->>'after' !~ '^[a-z][a-z0-9-]{1,63}$')) THEN
      RETURN jsonb_build_object('status',400,'error','invalid_request');
    END IF;
    SELECT count(*) INTO total FROM app_private.directory_units WHERE tenant_id=tenant AND confirmed_value IS NOT NULL
      AND (payload ? 'after' AND unit > payload->>'after' OR NOT payload ? 'after');
    SELECT coalesce(jsonb_agg(l.confirmed_value ORDER BY l.unit),'[]'::jsonb) INTO items
      FROM (SELECT * FROM app_private.directory_units WHERE tenant_id=tenant AND confirmed_value IS NOT NULL
        AND (payload ? 'after' AND unit > payload->>'after' OR NOT payload ? 'after')
        ORDER BY unit LIMIT least(GREATEST((payload->>'limit')::bigint,1), max_items)) l;
    RETURN jsonb_build_object('status',200,'value',jsonb_build_object('items',items,'total',total));
  WHEN 'group_list' THEN
    IF (payload - 'unit' - 'after' - 'limit') <> '{}'::jsonb OR coalesce(payload->>'unit','') !~ '^[a-z][a-z0-9-]{1,63}$'
       OR jsonb_typeof(payload->'limit') IS DISTINCT FROM 'number' OR payload->>'limit' !~ '^[0-9]{1,3}$'
       OR (payload ? 'after' AND (jsonb_typeof(payload->'after') IS DISTINCT FROM 'string'
           OR payload->>'after' !~ '^[a-z][a-z0-9-]{1,63}$')) THEN
      RETURN jsonb_build_object('status',400,'error','invalid_request');
    END IF;
    unit_key:=payload->>'unit';
    IF NOT EXISTS (SELECT 1 FROM app_private.directory_units u WHERE u.tenant_id=tenant AND u.unit=unit_key AND u.confirmed_value IS NOT NULL) THEN
      RETURN jsonb_build_object('status',404,'error','not_found');
    END IF;
    SELECT count(*) INTO total FROM app_private.directory_groups WHERE tenant_id=tenant AND unit=unit_key AND confirmed_value IS NOT NULL
      AND (payload ? 'after' AND unit_group > payload->>'after' OR NOT payload ? 'after');
    SELECT coalesce(jsonb_agg(l.confirmed_value ORDER BY l.unit_group),'[]'::jsonb) INTO items
      FROM (SELECT * FROM app_private.directory_groups WHERE tenant_id=tenant AND unit=unit_key AND confirmed_value IS NOT NULL
        AND (payload ? 'after' AND unit_group > payload->>'after' OR NOT payload ? 'after')
        ORDER BY unit_group LIMIT least(GREATEST((payload->>'limit')::bigint,1), max_items)) l;
    RETURN jsonb_build_object('status',200,'value',jsonb_build_object('items',items,'total',total));
  WHEN 'member_list' THEN
    IF (payload - 'unit' - 'after' - 'limit') <> '{}'::jsonb OR coalesce(payload->>'unit','') !~ '^[a-z][a-z0-9-]{1,63}$'
       OR jsonb_typeof(payload->'limit') IS DISTINCT FROM 'number' OR payload->>'limit' !~ '^[0-9]{1,3}$'
       OR (payload ? 'after' AND (jsonb_typeof(payload->'after') IS DISTINCT FROM 'string'
           OR payload->>'after' !~ '^[A-Za-z0-9:_-]{1,128}$')) THEN
      RETURN jsonb_build_object('status',400,'error','invalid_request');
    END IF;
    unit_key:=payload->>'unit';
    IF NOT EXISTS (SELECT 1 FROM app_private.directory_units u WHERE u.tenant_id=tenant AND u.unit=unit_key AND u.confirmed_value IS NOT NULL) THEN
      RETURN jsonb_build_object('status',404,'error','not_found');
    END IF;
    SELECT count(*) INTO total FROM app_private.directory_members WHERE tenant_id=tenant AND unit=unit_key AND confirmed_value IS NOT NULL
      AND (payload ? 'after' AND subject > payload->>'after' OR NOT payload ? 'after');
    SELECT coalesce(jsonb_agg(l.confirmed_value ORDER BY l.subject),'[]'::jsonb) INTO items
      FROM (SELECT * FROM app_private.directory_members WHERE tenant_id=tenant AND unit=unit_key AND confirmed_value IS NOT NULL
        AND (payload ? 'after' AND subject > payload->>'after' OR NOT payload ? 'after')
        ORDER BY subject LIMIT least(GREATEST((payload->>'limit')::bigint,1), max_items)) l;
    RETURN jsonb_build_object('status',200,'value',jsonb_build_object('items',items,'total',total));
  ELSE
    RETURN jsonb_build_object('status',400,'error','invalid_request');
  END CASE;
END $$;

ALTER FUNCTION core.directory_command(text,jsonb) OWNER TO junctura_app_owner;
REVOKE ALL ON FUNCTION core.directory_command(text,jsonb) FROM PUBLIC,junctura_api,junctura_app_api,junctura_resource_api,junctura_audit_api,junctura_capability_api,junctura_trust_api,junctura_execution_api,junctura_subject_api;
GRANT EXECUTE ON FUNCTION core.directory_command(text,jsonb) TO junctura_directory_api, junctura_directory_worker;
RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (37);
NOTIFY pgrst, 'reload schema';
COMMIT;
