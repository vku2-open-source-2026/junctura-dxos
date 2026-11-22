-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
-- Verified subject bindings: an operator-assigned subjectId is bound to exactly
-- one OIDC login subject per (tenant, issuer). Holders of a token can never
-- create or edit a binding through Core; provisioning inserts rows directly.
-- Core reads the binding to decide which token claims name a verified data
-- subject, so one row per subjectId and one subjectId per login subject.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='junctura_subject_api') THEN
    CREATE ROLE junctura_subject_api NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT junctura_subject_api TO junctura_data;
GRANT USAGE ON SCHEMA core TO junctura_subject_api;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

CREATE TABLE IF NOT EXISTS app_private.subject_bindings (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z][a-z0-9-]{0,62}$'),
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 2048),
  subject_id text COLLATE "C" NOT NULL CHECK (subject_id ~ '^[A-Za-z0-9:_-]{1,128}$'),
  login_subject text NOT NULL CHECK (length(login_subject) BETWEEN 1 AND 255 AND login_subject !~ '[[:cntrl:]]'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, issuer, subject_id),
  UNIQUE (tenant_id, issuer, login_subject)
);
ALTER TABLE app_private.subject_bindings OWNER TO junctura_app_owner;
ALTER TABLE app_private.subject_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.subject_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY record_tenant_isolation ON app_private.subject_bindings TO junctura_app_owner
  USING (tenant_id = (current_setting('request.jwt.claims', true)::jsonb->>'tenant_id'))
  WITH CHECK (tenant_id = (current_setting('request.jwt.claims', true)::jsonb->>'tenant_id'));
REVOKE ALL ON app_private.subject_bindings FROM PUBLIC;

-- Read-side check: the caller's own subject_id claim must be bound to the
-- caller's login subject in the verified tenant and issuer. Everything else
-- returns the same anonymous refusal; no foreign existence is disclosed.
CREATE OR REPLACE FUNCTION core.subject_binding(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c jsonb; tenant text; who text; iss text; sid text; bound text;
BEGIN
  IF payload IS NULL OR jsonb_typeof(payload)<>'object' OR payload<>'{}'::jsonb THEN
    RETURN jsonb_build_object('status',400,'error','invalid_request');
  END IF;
  BEGIN c:=current_setting('request.jwt.claims',true)::jsonb;
  EXCEPTION WHEN others THEN c:=NULL; END;
  tenant:=c->>'tenant_id'; who:=c->>'sub'; iss:=c->>'iss'; sid:=c->>'subject_id';
  IF c IS NULL OR tenant IS NULL OR tenant !~ '^[a-z][a-z0-9-]{0,62}$' OR coalesce(who,'')='' OR
     coalesce(iss,'')='' OR coalesce(sid,'')='' OR sid !~ '^[A-Za-z0-9:_-]{1,128}$' THEN
    RETURN jsonb_build_object('status',403,'error','verified_subject_required');
  END IF;
  SELECT b.login_subject INTO bound FROM app_private.subject_bindings b
    WHERE b.tenant_id=tenant AND b.issuer=iss AND b.subject_id=sid;
  IF bound IS NULL OR bound<>who THEN
    RETURN jsonb_build_object('status',403,'error','verified_subject_required');
  END IF;
  RETURN jsonb_build_object('status',200,'value',jsonb_build_object('subjectId',sid));
END $$;

ALTER FUNCTION core.subject_binding(jsonb) OWNER TO junctura_app_owner;
REVOKE ALL ON FUNCTION core.subject_binding(jsonb) FROM PUBLIC,junctura_api,junctura_app_api,junctura_resource_api,junctura_audit_api,junctura_capability_api,junctura_trust_api,junctura_execution_api,junctura_directory_api;
GRANT EXECUTE ON FUNCTION core.subject_binding(jsonb) TO junctura_subject_api;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (36);
NOTIFY pgrst, 'reload schema';
COMMIT;
