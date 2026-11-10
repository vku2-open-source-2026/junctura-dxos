-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
-- Optional presentation profile for enrolled management principals. The columns
-- stay nullable so existing principals keep working; when present they are
-- bounded, control-character free and never contain credentials. The read-only
-- directory function from 022 is replaced to return the new fields.
SET LOCAL ROLE junctura_app_owner;
ALTER TABLE app_private.principals ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE app_private.principals ADD COLUMN IF NOT EXISTS organization text;
ALTER TABLE app_private.principals ADD COLUMN IF NOT EXISTS job_title text;
ALTER TABLE app_private.principals ADD COLUMN IF NOT EXISTS kind text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname='principals_display_name_check') THEN
    ALTER TABLE app_private.principals ADD CONSTRAINT principals_display_name_check
      CHECK (display_name IS NULL OR (length(display_name) BETWEEN 1 AND 200 AND display_name !~ '[[:cntrl:]]'));
  END IF;
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname='principals_organization_check') THEN
    ALTER TABLE app_private.principals ADD CONSTRAINT principals_organization_check
      CHECK (organization IS NULL OR (length(organization) BETWEEN 1 AND 200 AND organization !~ '[[:cntrl:]]'));
  END IF;
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname='principals_job_title_check') THEN
    ALTER TABLE app_private.principals ADD CONSTRAINT principals_job_title_check
      CHECK (job_title IS NULL OR (length(job_title) BETWEEN 1 AND 200 AND job_title !~ '[[:cntrl:]]'));
  END IF;
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname='principals_kind_check') THEN
    ALTER TABLE app_private.principals ADD CONSTRAINT principals_kind_check
      CHECK (kind IS NULL OR kind IN ('admin','application'));
  END IF;
END $$;
RESET ROLE;

GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

CREATE OR REPLACE FUNCTION core.directory_principals(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c jsonb; tenant text; who text; iss text; client text;
  items jsonb; total integer; max_items constant integer := 1000;
BEGIN
  IF payload IS NULL OR jsonb_typeof(payload)<>'object' OR payload<>'{}'::jsonb THEN
    RETURN jsonb_build_object('status',400,'error','invalid_directory_request');
  END IF;
  BEGIN c:=current_setting('request.jwt.claims',true)::jsonb;
  EXCEPTION WHEN others THEN c:=NULL; END;
  IF c IS NULL OR jsonb_typeof(c)<>'object' THEN
    RETURN jsonb_build_object('status',403,'error','directory_permission_required');
  END IF;
  tenant:=c->>'tenant_id'; who:=c->>'sub'; iss:=c->>'iss'; client:=c->>'client_id';
  IF tenant IS NULL OR tenant !~ '^[a-z][a-z0-9-]{0,62}$' OR coalesce(who,'')='' OR
     coalesce(iss,'')='' OR coalesce(client,'')='' THEN
    RETURN jsonb_build_object('status',403,'error','directory_permission_required');
  END IF;
  PERFORM 1 FROM app_private.principals p
    WHERE p.tenant_id=tenant AND p.issuer=iss AND p.subject=who
      AND p.management_client=client AND p.enabled
      AND p.permissions @> ARRAY['audit.read']::text[];
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status',403,'error','directory_permission_required');
  END IF;

  WITH visible AS (
    SELECT p.subject, p.issuer, p.management_client, p.permissions, p.enabled,
           p.display_name, p.organization, p.job_title, p.kind
      FROM app_private.principals p
      WHERE p.tenant_id=tenant AND p.issuer=iss
  ), limited AS (
    SELECT * FROM visible ORDER BY subject, issuer, management_client LIMIT max_items
  )
  SELECT (SELECT count(*) FROM visible), coalesce(jsonb_agg(jsonb_build_object(
      'subject',l.subject,'issuer',l.issuer,'managementClient',l.management_client,
      'permissions',to_jsonb(l.permissions),'enabled',l.enabled,
      'displayName',l.display_name,'organization',l.organization,
      'jobTitle',l.job_title,'kind',l.kind)
      ORDER BY l.subject,l.issuer,l.management_client),'[]'::jsonb)
    INTO total, items FROM limited l;
  RETURN jsonb_build_object('status',200,'value',jsonb_build_object(
    'items',items,'truncated',total>max_items));
END $$;

RESET ROLE;
ALTER FUNCTION core.directory_principals(jsonb) OWNER TO junctura_app_owner;
REVOKE ALL ON FUNCTION core.directory_principals(jsonb) FROM PUBLIC,junctura_api,junctura_app_api,junctura_resource_api,junctura_audit_api,junctura_capability_api,junctura_trust_api,junctura_execution_api,junctura_composition_api,junctura_subject_api;
GRANT EXECUTE ON FUNCTION core.directory_principals(jsonb) TO junctura_directory_api;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES(23);
NOTIFY pgrst,'reload schema';
COMMIT;
