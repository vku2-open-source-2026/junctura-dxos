-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
-- Directory management: operator-managed unit types, flat units, per-unit
-- groups and unit memberships. Every change is stored as durable desired
-- state with a per-row generation and a synchronization status toward the
-- identity provider. A write is only confirmed after the generated state has
-- been read back, and an older job can never confirm over a newer generation,
-- so repeated and concurrent writes converge. Deletions stay as tombstones
-- until confirmed, so a generation is never reused across a delete and a
-- recreate, and every command takes a per-tenant advisory lock so replicas
-- serialize on PostgreSQL instead of process-local maps.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='junctura_directory_api') THEN
    CREATE ROLE junctura_directory_api NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT junctura_directory_api TO junctura_data;
GRANT USAGE ON SCHEMA core TO junctura_directory_api;
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

-- Management RPC for the directory desired state. The verified caller must be
-- an enabled enrolled management principal holding directory.write in its own
-- tenant, and mutations additionally require the core-writer role relayed by
-- Core in the internal token. Every command takes a per-tenant transaction
-- advisory lock, so concurrent writes and lists serialize on PostgreSQL no
-- matter which replica serves them. Keycloak itself is only touched by the
-- Node side between the prepare and confirm operations, which are keyed by
-- generation; a confirm that updates zero rows is a lost race and reports a
-- conflict instead of success. List operations use ascending identifier order
-- with a keyset cursor and hide tombstoned rows.
CREATE OR REPLACE FUNCTION core.directory_command(operation text, payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  c jsonb; tenant text; who text; iss text; client text;
  key text; unit_key text; desired_name text; desired_type text; gen bigint; prior text; synced bigint; pending boolean;
  created boolean; desired text[]; current_groups text[]; items jsonb; total bigint;
  max_items constant bigint := 100;
BEGIN
  BEGIN c:=current_setting('request.jwt.claims',true)::jsonb;
  EXCEPTION WHEN others THEN c:=NULL; END;
  tenant:=c->>'tenant_id'; who:=c->>'sub'; iss:=c->>'iss'; client:=c->>'client_id';
  IF c IS NULL OR tenant IS NULL OR tenant !~ '^[a-z][a-z0-9-]{0,62}$' OR coalesce(who,'')='' OR
     coalesce(iss,'')='' OR coalesce(client,'')='' THEN
    RETURN jsonb_build_object('status',403,'error','forbidden');
  END IF;
  PERFORM 1 FROM app_private.principals p
    WHERE p.tenant_id=tenant AND p.issuer=iss AND p.subject=who
      AND p.management_client=client AND p.enabled AND 'directory.write'=ANY(p.permissions);
  IF NOT FOUND THEN RETURN jsonb_build_object('status',403,'error','forbidden'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('junctura-directory:'||tenant,0));
  IF operation NOT IN ('unit_type_list','unit_list','group_list','member_list')
     AND coalesce(c->>'directory_writer','') IS DISTINCT FROM 'true' THEN
    RETURN jsonb_build_object('status',403,'error','write_forbidden');
  END IF;
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('status',400,'error','invalid_request');
  END IF;

  CASE operation
  WHEN 'unit_type_put' THEN
    IF (payload - 'unitType' - 'name') <> '{}'::jsonb OR coalesce(payload->>'unitType','') !~ '^[a-z][a-z0-9-]{1,63}$'
       OR jsonb_typeof(payload->'name') IS DISTINCT FROM 'string'
       OR length(payload->>'name') NOT BETWEEN 1 AND 120 OR payload->>'name' ~ '[[:cntrl:]]' THEN
      RETURN jsonb_build_object('status',400,'error','invalid_request');
    END IF;
    key:=payload->>'unitType'; desired_name:=payload->>'name';
    SELECT generation, synced_generation, name, pending_delete INTO gen, synced, prior, pending FROM app_private.directory_unit_types
      WHERE tenant_id=tenant AND unit_type=key FOR UPDATE;
    IF FOUND AND NOT pending AND synced=gen AND prior=desired_name THEN
      RETURN jsonb_build_object('status',200,'generation',to_jsonb(gen),'confirmed',true);
    END IF;
    IF FOUND AND NOT pending AND prior=desired_name THEN
      RETURN jsonb_build_object('status',200,'generation',to_jsonb(gen));
    END IF;
    IF NOT FOUND THEN
      INSERT INTO app_private.directory_unit_types(tenant_id,unit_type,name,generation) VALUES(tenant,key,desired_name,1);
      gen:=1; created:=true;
    ELSE
      UPDATE app_private.directory_unit_types SET name=desired_name, generation=generation+1, synced_generation=NULL,
        pending_delete=false, updated_at=clock_timestamp() WHERE tenant_id=tenant AND unit_type=key RETURNING generation INTO gen;
      created:=pending AND synced=gen;
    END IF;
    RETURN jsonb_build_object('status',CASE WHEN created THEN 201 ELSE 200 END,'generation',to_jsonb(gen));
  WHEN 'unit_type_confirm' THEN
    IF (payload - 'unitType' - 'generation') <> '{}'::jsonb OR coalesce(payload->>'unitType','') !~ '^[a-z][a-z0-9-]{1,63}$'
       OR jsonb_typeof(payload->'generation') IS DISTINCT FROM 'number'
       OR payload->>'generation' !~ '^[0-9]{1,16}$' THEN
      RETURN jsonb_build_object('status',400,'error','invalid_request');
    END IF;
    UPDATE app_private.directory_unit_types SET synced_generation=(payload->>'generation')::bigint, updated_at=clock_timestamp()
      WHERE tenant_id=tenant AND unit_type=payload->>'unitType' AND generation=(payload->>'generation')::bigint AND NOT pending_delete;
    IF NOT FOUND THEN RETURN jsonb_build_object('status',409,'error','resource_conflict'); END IF;
    RETURN jsonb_build_object('status',204);
  WHEN 'unit_type_delete' THEN
    IF (payload - 'unitType') <> '{}'::jsonb OR coalesce(payload->>'unitType','') !~ '^[a-z][a-z0-9-]{1,63}$' THEN
      RETURN jsonb_build_object('status',400,'error','invalid_request');
    END IF;
    SELECT generation, pending_delete, synced_generation INTO gen, pending, synced FROM app_private.directory_unit_types
      WHERE tenant_id=tenant AND unit_type=payload->>'unitType' FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('status',204); END IF;
    IF EXISTS (SELECT 1 FROM app_private.directory_units u WHERE u.tenant_id=tenant AND u.unit_type=payload->>'unitType' AND NOT u.pending_delete) THEN
      RETURN jsonb_build_object('status',409,'error','resource_conflict');
    END IF;
    IF pending AND synced=gen THEN RETURN jsonb_build_object('status',204); END IF;
    IF NOT pending THEN
      UPDATE app_private.directory_unit_types SET pending_delete=true, generation=generation+1, synced_generation=NULL,
        updated_at=clock_timestamp() WHERE tenant_id=tenant AND unit_type=payload->>'unitType' RETURNING generation INTO gen;
    END IF;
    RETURN jsonb_build_object('status',204,'generation',to_jsonb(gen));
  WHEN 'unit_type_delete_confirm' THEN
    IF (payload - 'unitType' - 'generation') <> '{}'::jsonb OR coalesce(payload->>'unitType','') !~ '^[a-z][a-z0-9-]{1,63}$'
       OR jsonb_typeof(payload->'generation') IS DISTINCT FROM 'number'
       OR payload->>'generation' !~ '^[0-9]{1,16}$' THEN
      RETURN jsonb_build_object('status',400,'error','invalid_request');
    END IF;
    UPDATE app_private.directory_unit_types SET synced_generation=(payload->>'generation')::bigint, updated_at=clock_timestamp()
      WHERE tenant_id=tenant AND unit_type=payload->>'unitType'
      AND generation=(payload->>'generation')::bigint AND pending_delete;
    IF NOT FOUND THEN RETURN jsonb_build_object('status',409,'error','resource_conflict'); END IF;
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
      UPDATE app_private.directory_units SET unit_type=key, name=desired_name, generation=generation+1, synced_generation=NULL,
        pending_delete=false, updated_at=clock_timestamp() WHERE tenant_id=tenant AND unit=unit_key RETURNING generation INTO gen;
      created:=pending AND synced=gen;
    END IF;
    RETURN jsonb_build_object('status',CASE WHEN created THEN 201 ELSE 200 END,'generation',to_jsonb(gen));
  WHEN 'unit_confirm' THEN
    IF (payload - 'unit' - 'generation') <> '{}'::jsonb OR coalesce(payload->>'unit','') !~ '^[a-z][a-z0-9-]{1,63}$'
       OR jsonb_typeof(payload->'generation') IS DISTINCT FROM 'number'
       OR payload->>'generation' !~ '^[0-9]{1,16}$' THEN
      RETURN jsonb_build_object('status',400,'error','invalid_request');
    END IF;
    UPDATE app_private.directory_units SET synced_generation=(payload->>'generation')::bigint, updated_at=clock_timestamp()
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
    IF EXISTS (SELECT 1 FROM app_private.directory_groups g WHERE g.tenant_id=tenant AND g.unit=unit_key AND NOT g.pending_delete)
       OR EXISTS (SELECT 1 FROM app_private.directory_members m WHERE m.tenant_id=tenant AND m.unit=unit_key AND NOT m.pending_delete) THEN
      RETURN jsonb_build_object('status',409,'error','resource_conflict');
    END IF;
    IF pending AND synced=gen THEN RETURN jsonb_build_object('status',204); END IF;
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
    UPDATE app_private.directory_units SET synced_generation=(payload->>'generation')::bigint, updated_at=clock_timestamp()
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
      UPDATE app_private.directory_groups SET name=desired_name, generation=generation+1, synced_generation=NULL,
        pending_delete=false, updated_at=clock_timestamp() WHERE tenant_id=tenant AND unit=unit_key AND unit_group=key RETURNING generation INTO gen;
      created:=pending AND synced=gen;
    END IF;
    RETURN jsonb_build_object('status',CASE WHEN created THEN 201 ELSE 200 END,'generation',to_jsonb(gen));
  WHEN 'group_confirm' THEN
    IF (payload - 'unit' - 'group' - 'generation') <> '{}'::jsonb OR coalesce(payload->>'unit','') !~ '^[a-z][a-z0-9-]{1,63}$'
       OR coalesce(payload->>'group','') !~ '^[a-z][a-z0-9-]{1,63}$'
       OR jsonb_typeof(payload->'generation') IS DISTINCT FROM 'number'
       OR payload->>'generation' !~ '^[0-9]{1,16}$' THEN
      RETURN jsonb_build_object('status',400,'error','invalid_request');
    END IF;
    UPDATE app_private.directory_groups SET synced_generation=(payload->>'generation')::bigint, updated_at=clock_timestamp()
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
    IF EXISTS (SELECT 1 FROM app_private.directory_memberships m WHERE m.tenant_id=tenant AND m.unit=unit_key AND m.unit_group=key) THEN
      RETURN jsonb_build_object('status',409,'error','resource_conflict');
    END IF;
    IF pending AND synced=gen THEN RETURN jsonb_build_object('status',204); END IF;
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
    UPDATE app_private.directory_groups SET synced_generation=(payload->>'generation')::bigint, updated_at=clock_timestamp()
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
    created := NOT FOUND OR (pending AND synced=gen);
    SELECT coalesce(array_agg(m.unit_group ORDER BY m.unit_group),'{}'::text[]) INTO current_groups
      FROM app_private.directory_memberships m WHERE m.tenant_id=tenant AND m.unit=unit_key AND m.subject=key;
    IF FOUND AND NOT pending AND synced=gen AND current_groups IS NOT DISTINCT FROM coalesce(desired,'{}'::text[]) THEN
      RETURN jsonb_build_object('status',200,'generation',to_jsonb(gen),'confirmed',true);
    END IF;
    IF FOUND AND NOT pending AND current_groups IS NOT DISTINCT FROM coalesce(desired,'{}'::text[]) THEN
      RETURN jsonb_build_object('status',200,'generation',to_jsonb(gen));
    END IF;
    IF NOT FOUND THEN
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
    UPDATE app_private.directory_members SET synced_generation=(payload->>'generation')::bigint, updated_at=clock_timestamp()
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
    IF pending AND synced=gen THEN RETURN jsonb_build_object('status',204); END IF;
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
    UPDATE app_private.directory_members SET synced_generation=(payload->>'generation')::bigint, updated_at=clock_timestamp()
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
    SELECT count(*) INTO total FROM app_private.directory_units WHERE tenant_id=tenant AND NOT pending_delete
      AND (payload ? 'after' AND unit > payload->>'after' OR NOT payload ? 'after');
    SELECT coalesce(jsonb_agg(jsonb_build_object('unit',l.unit,'unitType',l.unit_type,'name',l.name) ORDER BY l.unit),'[]'::jsonb) INTO items
      FROM (SELECT * FROM app_private.directory_units WHERE tenant_id=tenant AND NOT pending_delete
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
    IF NOT EXISTS (SELECT 1 FROM app_private.directory_units u WHERE u.tenant_id=tenant AND u.unit=unit_key AND NOT u.pending_delete) THEN
      RETURN jsonb_build_object('status',404,'error','not_found');
    END IF;
    SELECT count(*) INTO total FROM app_private.directory_groups WHERE tenant_id=tenant AND unit=unit_key AND NOT pending_delete
      AND (payload ? 'after' AND unit_group > payload->>'after' OR NOT payload ? 'after');
    SELECT coalesce(jsonb_agg(jsonb_build_object('unit',l.unit,'group',l.unit_group,'name',l.name) ORDER BY l.unit_group),'[]'::jsonb) INTO items
      FROM (SELECT * FROM app_private.directory_groups WHERE tenant_id=tenant AND unit=unit_key AND NOT pending_delete
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
    IF NOT EXISTS (SELECT 1 FROM app_private.directory_units u WHERE u.tenant_id=tenant AND u.unit=unit_key AND NOT u.pending_delete) THEN
      RETURN jsonb_build_object('status',404,'error','not_found');
    END IF;
    SELECT count(*) INTO total FROM app_private.directory_members WHERE tenant_id=tenant AND unit=unit_key AND NOT pending_delete
      AND (payload ? 'after' AND subject > payload->>'after' OR NOT payload ? 'after');
    SELECT coalesce(jsonb_agg(jsonb_build_object('unit',l.unit,'subject',l.subject,
        'groups',(SELECT coalesce(jsonb_agg(m.unit_group ORDER BY m.unit_group),'[]'::jsonb) FROM app_private.directory_memberships m
          WHERE m.tenant_id=l.tenant_id AND m.unit=l.unit AND m.subject=l.subject))
      ORDER BY l.subject),'[]'::jsonb) INTO items
      FROM (SELECT * FROM app_private.directory_members WHERE tenant_id=tenant AND unit=unit_key AND NOT pending_delete
        AND (payload ? 'after' AND subject > payload->>'after' OR NOT payload ? 'after')
        ORDER BY subject LIMIT least(GREATEST((payload->>'limit')::bigint,1), max_items)) l;
    RETURN jsonb_build_object('status',200,'value',jsonb_build_object('items',items,'total',total));
  ELSE
    RETURN jsonb_build_object('status',400,'error','invalid_request');
  END CASE;
END $$;

ALTER FUNCTION core.directory_command(text,jsonb) OWNER TO junctura_app_owner;
REVOKE ALL ON FUNCTION core.directory_command(text,jsonb) FROM PUBLIC,junctura_api,junctura_app_api,junctura_resource_api,junctura_audit_api,junctura_capability_api,junctura_trust_api,junctura_execution_api,junctura_subject_api;
GRANT EXECUTE ON FUNCTION core.directory_command(text,jsonb) TO junctura_directory_api;
RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (37);
NOTIFY pgrst, 'reload schema';
COMMIT;
