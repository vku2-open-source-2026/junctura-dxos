-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
GRANT USAGE ON SCHEMA core TO junctura_resource_api;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

CREATE TABLE app_private.app_groups (
  tenant_id text NOT NULL,
  app_group text COLLATE "C" NOT NULL CHECK (app_group ~ '^[a-z][a-z0-9-]{1,63}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, app_group)
);
CREATE TABLE app_private.app_group_memberships (
  tenant_id text NOT NULL,
  app_group text COLLATE "C" NOT NULL,
  app_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, app_group, app_id),
  FOREIGN KEY (tenant_id, app_group) REFERENCES app_private.app_groups (tenant_id, app_group) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, app_id) REFERENCES app_private.applications (tenant_id, app_id) ON DELETE CASCADE
);
CREATE INDEX app_group_membership_app_idx ON app_private.app_group_memberships (tenant_id, app_id, app_group);
ALTER TABLE app_private.app_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.app_groups FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.app_group_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.app_group_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY record_tenant_isolation ON app_private.app_groups TO junctura_app_owner
  USING (tenant_id = (current_setting('request.jwt.claims', true)::jsonb->>'tenant_id'))
  WITH CHECK (tenant_id = (current_setting('request.jwt.claims', true)::jsonb->>'tenant_id'));
CREATE POLICY record_tenant_isolation ON app_private.app_group_memberships TO junctura_app_owner
  USING (tenant_id = (current_setting('request.jwt.claims', true)::jsonb->>'tenant_id'))
  WITH CHECK (tenant_id = (current_setting('request.jwt.claims', true)::jsonb->>'tenant_id'));

ALTER TABLE app_private.resource_shares ALTER COLUMN grantee_app_id DROP NOT NULL;
ALTER TABLE app_private.resource_shares ADD COLUMN grantee_app_group text COLLATE "C"
  CHECK (grantee_app_group IS NULL OR grantee_app_group ~ '^[a-z][a-z0-9-]{1,63}$');
ALTER TABLE app_private.resource_shares ADD CONSTRAINT resource_shares_one_grantee
  CHECK ((grantee_app_id IS NOT NULL) <> (grantee_app_group IS NOT NULL));
ALTER TABLE app_private.resource_shares ADD CONSTRAINT resource_shares_group_fk
  FOREIGN KEY (tenant_id, grantee_app_group) REFERENCES app_private.app_groups (tenant_id, app_group) ON DELETE CASCADE;
CREATE INDEX resource_share_group_lookup ON app_private.resource_shares
  (tenant_id, resource_type, resource_id, grantee_app_group) WHERE NOT revoked AND grantee_app_group IS NOT NULL;

CREATE OR REPLACE FUNCTION core.resource_readable(owner_app uuid, kind text, resource uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app_private, pg_temp AS $$
  SELECT core.resource_actor() IS NOT NULL AND app_private.resource_app_active(owner_app) AND
    (owner_app = core.resource_actor() OR EXISTS (
      SELECT FROM app_private.resource_shares s
      WHERE s.tenant_id = current_setting('request.jwt.claims', true)::jsonb->>'tenant_id'
        AND s.owner_app_id = owner_app AND s.resource_type = kind AND s.resource_id = resource
        AND s.action = 'read' AND NOT s.revoked AND s.expires_at > now()
        AND (s.grantee_app_id = core.resource_actor() OR (s.grantee_app_group IS NOT NULL AND EXISTS (
          SELECT FROM app_private.app_group_memberships m
          WHERE m.tenant_id = s.tenant_id AND m.app_group = s.grantee_app_group AND m.app_id = core.resource_actor()
        )))
    ))
$$;

CREATE FUNCTION core.record_share_command(operation text, payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app_private, pg_temp
SET lock_timeout = '2s' AS $$
DECLARE
  claims jsonb := current_setting('request.jwt.claims', true)::jsonb;
  tenant text := record_tenant();
  actor uuid;
  body jsonb;
  resource uuid;
  kind text;
  grantee uuid;
  grantee_text text;
  group_name text;
  expiry_text text;
  expiry timestamptz;
  share app_private.resource_shares;
  result jsonb;
  request_key uuid;
  request_digest bytea;
  scope bytea;
BEGIN
  IF nullif(claims->>'client_id', '') IS NULL OR nullif(claims->>'sub', '') IS NULL
    OR nullif(claims->>'iss', '') IS NULL OR nullif(tenant, '') IS NULL THEN
    RETURN record_error(403, 'verified_client_required');
  END IF;
  actor := record_actor(true);
  IF actor IS NULL THEN RETURN record_error(403, 'application_access_required'); END IF;
  IF NOT core.resource_writer() THEN RETURN record_error(403, 'write_forbidden'); END IF;
  IF operation <> 'create' THEN RETURN record_error(400, 'invalid_request'); END IF;
  body := payload->'share';
  IF body IS NULL OR jsonb_typeof(body) <> 'object' THEN RETURN record_error(400, 'invalid_share'); END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(body)) <> 5 OR
      NOT (body ? 'resourceType') OR NOT (body ? 'resourceId') OR NOT (body ? 'action') OR
      NOT (body ? 'expiresAt') OR ((body ? 'granteeAppId') = (body ? 'granteeAppGroup')) THEN
    RETURN record_error(400, 'invalid_share');
  END IF;
  IF payload->>'requestKey' IS NOT NULL THEN
    IF coalesce(payload->>'digest', '') !~ '^[0-9a-f]{64}$' OR nullif(payload->>'path', '') IS NULL OR
        nullif(payload->>'method', '') IS NULL THEN RETURN record_error(400, 'invalid_request'); END IF;
    request_key := (payload->>'requestKey')::uuid;
    request_digest := decode(payload->>'digest', 'hex');
    scope := record_caller_scope(actor);
    result := record_replay(scope, payload->>'method', payload->>'path', request_key, request_digest);
    IF result IS NOT NULL THEN RETURN result; END IF;
  END IF;
  IF body->>'action' <> 'read' OR coalesce(body->>'resourceType', '') NOT IN ('record', 'object') OR
      coalesce(body->>'resourceId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN record_error(400, 'invalid_share');
  END IF;
  kind := body->>'resourceType';
  resource := (body->>'resourceId')::uuid;
  grantee_text := nullif(body->>'granteeAppId', '');
  group_name := nullif(body->>'granteeAppGroup', '');
  IF grantee_text IS NOT NULL AND grantee_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN record_error(400, 'invalid_share');
  END IF;
  grantee := grantee_text::uuid;
  IF group_name IS NOT NULL AND (kind <> 'record' OR group_name !~ '^[a-z][a-z0-9-]{1,63}$') THEN
    RETURN record_error(400, 'invalid_share');
  END IF;
  expiry_text := body->>'expiresAt';
  expiry := record_time('date-time', expiry_text);
  IF expiry IS NULL OR expiry <= now() OR expiry > now() + interval '24 hours' THEN RETURN record_error(400, 'invalid_share'); END IF;
  IF grantee IS NOT NULL THEN
    IF grantee = actor OR NOT resource_app_active(grantee) THEN RETURN record_error(404, 'not_found'); END IF;
  ELSE
    IF NOT EXISTS (SELECT FROM app_groups g WHERE g.tenant_id = tenant AND g.app_group = group_name) THEN
      RETURN record_error(404, 'not_found');
    END IF;
  END IF;
  IF kind = 'record' THEN
    PERFORM 1 FROM core.app_records WHERE tenant_id = tenant AND id = resource AND owner_app_id = actor FOR UPDATE;
  ELSE
    PERFORM 1 FROM app_private.resource_objects WHERE tenant_id = tenant AND id = resource AND owner_app_id = actor AND NOT deleted AND version IS NOT NULL FOR UPDATE;
  END IF;
  IF NOT FOUND THEN RETURN record_error(404, 'not_found'); END IF;
  INSERT INTO resource_shares (tenant_id, owner_app_id, grantee_app_id, grantee_app_group, resource_type, resource_id, action, expires_at)
    VALUES (tenant, actor, grantee, group_name, kind, resource, 'read', expiry)
    RETURNING * INTO share;
  INSERT INTO audit (tenant_id, issuer, subject, management_client, event, resource_id, revision)
    VALUES (tenant, claims->>'iss', claims->>'sub', claims->>'client_id', 'resource.share_created', share.share_id, 1);
  result := jsonb_build_object('status', 201, 'value', jsonb_build_object(
    'shareId', share.share_id, 'resourceType', share.resource_type, 'resourceId', share.resource_id,
    'action', share.action, 'expiresAt', share.expires_at) ||
    CASE WHEN share.grantee_app_id IS NOT NULL THEN jsonb_build_object('granteeAppId', share.grantee_app_id)
         ELSE jsonb_build_object('granteeAppGroup', share.grantee_app_group) END);
  IF request_key IS NOT NULL THEN
    PERFORM record_save_replay(scope, payload->>'method', payload->>'path', request_key, request_digest, result);
  END IF;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION core.resource_readable(uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION core.record_share_command(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.resource_readable(uuid, text, uuid) TO junctura_resource_api;
GRANT EXECUTE ON FUNCTION core.record_share_command(text, jsonb) TO junctura_resource_api;
RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (35);
NOTIFY pgrst, 'reload schema';
COMMIT;
