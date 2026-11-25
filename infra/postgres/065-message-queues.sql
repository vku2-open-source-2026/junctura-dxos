-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'junctura_queue_api') THEN
    CREATE ROLE junctura_queue_api NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT junctura_queue_api TO junctura_data;
GRANT USAGE ON SCHEMA core TO junctura_queue_api;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

CREATE TABLE app_private.message_queues (
  tenant_id text NOT NULL,
  queue_id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9-]{0,62}$'),
  owner_app_id uuid NOT NULL,
  producer_apps uuid[] NOT NULL,
  consumer_apps uuid[] NOT NULL,
  producer_versions uuid[] NOT NULL,
  consumer_versions uuid[] NOT NULL,
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
  PRIMARY KEY (tenant_id, queue_id),
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id, owner_app_id) REFERENCES app_private.applications (tenant_id, app_id)
);

CREATE TABLE app_private.queue_messages (
  tenant_id text NOT NULL,
  queue_id uuid NOT NULL,
  message_id uuid NOT NULL DEFAULT gen_random_uuid(),
  producer_app_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  request_digest bytea NOT NULL,
  payload_json text CHECK (octet_length(payload_json) <= 65536),
  available_at timestamptz NOT NULL,
  max_attempts integer NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND max_attempts),
  lease_app_id uuid,
  lease_token uuid,
  dead_at timestamptz,
  PRIMARY KEY (tenant_id, queue_id, message_id),
  UNIQUE (tenant_id, queue_id, producer_app_id, idempotency_key),
  FOREIGN KEY (tenant_id, queue_id) REFERENCES app_private.message_queues (tenant_id, queue_id),
  FOREIGN KEY (tenant_id, producer_app_id) REFERENCES app_private.applications (tenant_id, app_id),
  CHECK ((lease_app_id IS NULL) = (lease_token IS NULL))
);

CREATE INDEX queue_messages_ready ON app_private.queue_messages (tenant_id, queue_id, available_at, message_id)
  WHERE payload_json IS NOT NULL AND dead_at IS NULL;
CREATE INDEX queue_messages_dead ON app_private.queue_messages (tenant_id, queue_id, message_id)
  WHERE dead_at IS NOT NULL;

ALTER TABLE app_private.message_queues ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.message_queues FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app_private.message_queues TO junctura_app_owner
  USING (tenant_id = app_private.record_tenant());
ALTER TABLE app_private.queue_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.queue_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app_private.queue_messages TO junctura_app_owner
  USING (tenant_id = app_private.record_tenant());

CREATE FUNCTION core.queue_command(operation text, queue_name text, payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app_private, pg_temp
SET lock_timeout = '2s' SET timezone = 'UTC' AS $$
DECLARE
  tenant text := record_tenant();
  claims jsonb := current_setting('request.jwt.claims', true)::jsonb;
  actor uuid;
  request_id uuid := (payload->>'requestId')::uuid;
  target_id uuid := (payload->>'messageId')::uuid;
  q message_queues;
  msg queue_messages;
  status integer := 200;
  result jsonb;
  reason text;
  idempotency uuid;
  digest bytea;
  delay_seconds integer;
  now_at timestamptz;
  lease_until timestamptz;
  app_ids uuid[];
  version_ids uuid[];
  page_limit integer;
  page_cursor uuid;
BEGIN
  IF operation IS NULL OR operation NOT IN ('configure', 'send', 'lease', 'ack', 'nack', 'list', 'replay') THEN
    RETURN record_error(400, 'invalid_queue_request');
  END IF;
  IF NOT (claims ? 'actor_sub') THEN actor := record_actor(true); END IF;
  IF actor IS NULL OR (operation <> 'list' AND claims->'trust_writer' IS DISTINCT FROM 'true'::jsonb) THEN
    PERFORM audit_append('audit.queue_' || operation, 'audit', request_id, 0, 'denied', 'queue_forbidden');
    RETURN record_error(403, 'queue_forbidden');
  END IF;

  IF operation = 'configure' THEN
    INSERT INTO message_queues AS existing (tenant_id, name, owner_app_id, producer_apps, consumer_apps,
      producer_versions, consumer_versions, max_attempts)
    VALUES (tenant, queue_name, actor,
      ARRAY(SELECT jsonb_array_elements_text(payload->'producerAppIds')::uuid),
      ARRAY(SELECT jsonb_array_elements_text(payload->'consumerAppIds')::uuid),
      ARRAY(SELECT jsonb_array_elements_text(payload->'producerCapabilityVersionIds')::uuid),
      ARRAY(SELECT jsonb_array_elements_text(payload->'consumerCapabilityVersionIds')::uuid),
      (payload->>'maxAttempts')::integer)
    ON CONFLICT (tenant_id, name) DO UPDATE SET producer_apps = excluded.producer_apps,
      consumer_apps = excluded.consumer_apps, producer_versions = excluded.producer_versions,
      consumer_versions = excluded.consumer_versions, max_attempts = excluded.max_attempts
    WHERE existing.owner_app_id = actor
    RETURNING * INTO q;
    IF q.queue_id IS NULL THEN
      PERFORM audit_append('audit.queue_configure', 'audit', request_id, 0, 'denied', 'queue_forbidden');
      RETURN record_error(403, 'queue_forbidden');
    END IF;
    result := jsonb_build_object('queueId', q.queue_id, 'name', q.name, 'ownerAppId', actor, 'maxAttempts', q.max_attempts);
  ELSE
    SELECT * INTO q FROM message_queues WHERE tenant_id = tenant AND name = queue_name FOR SHARE;
    IF operation = 'send' THEN
      app_ids := q.producer_apps;
      version_ids := q.producer_versions;
    ELSIF operation IN ('lease', 'ack', 'nack') THEN
      app_ids := q.consumer_apps;
      version_ids := q.consumer_versions;
    END IF;
    IF q.queue_id IS NULL OR (actor <> q.owner_app_id AND (
      NOT resource_app_active(q.owner_app_id) OR NOT (
        coalesce(actor = ANY(app_ids), false) OR EXISTS (
          SELECT FROM capability_versions v WHERE v.tenant_id = tenant AND v.provider_app_id = q.owner_app_id
            AND v.version_id = ANY(version_ids) AND trust_private.granted(v, 'invoke')
        )
      )
    )) THEN
      PERFORM audit_append('audit.queue_' || operation, 'audit', coalesce(q.queue_id, request_id), 0, 'denied', 'queue_forbidden');
      RETURN record_error(403, 'queue_forbidden');
    END IF;

    CASE operation
      WHEN 'send' THEN
        idempotency := (payload->>'key')::uuid;
        delay_seconds := (payload->>'delaySeconds')::integer;
        digest := sha256(convert_to(jsonb_build_array((payload->>'payloadJson')::jsonb, delay_seconds)::text, 'UTF8'));
        INSERT INTO queue_messages (tenant_id, queue_id, producer_app_id, idempotency_key, request_digest,
          payload_json, available_at, max_attempts)
        VALUES (tenant, q.queue_id, actor, idempotency, digest, payload->>'payloadJson',
          clock_timestamp() + make_interval(secs => delay_seconds), q.max_attempts)
        ON CONFLICT (tenant_id, queue_id, producer_app_id, idempotency_key) DO NOTHING RETURNING * INTO msg;
        IF NOT FOUND THEN
          SELECT * INTO msg FROM queue_messages WHERE tenant_id = tenant AND queue_id = q.queue_id
            AND producer_app_id = actor AND idempotency_key = idempotency;
          IF msg.request_digest IS DISTINCT FROM digest THEN
            PERFORM audit_append('audit.queue_send', 'audit', msg.message_id, 0, 'failed', 'idempotency_key_reused');
            RETURN record_error(409, 'idempotency_key_reused');
          END IF;
          reason := 'idempotent_replay';
        END IF;
        status := 201;
        result := jsonb_build_object('messageId', msg.message_id);

      WHEN 'lease' THEN
        SELECT * INTO msg FROM queue_messages WHERE tenant_id = tenant AND queue_id = q.queue_id
          AND payload_json IS NOT NULL AND dead_at IS NULL AND available_at <= statement_timestamp()
          ORDER BY available_at, message_id LIMIT 1 FOR UPDATE SKIP LOCKED;
        IF FOUND THEN
          lease_until := clock_timestamp() + make_interval(secs => (payload->>'visibilityTimeoutSeconds')::integer);
          -- The last lease schedules dead-letter visibility at expiry. Ack or nack
          -- can still settle it before then, and the time boundary needs no worker.
          UPDATE queue_messages SET attempts = attempts + 1, available_at = lease_until,
            lease_app_id = actor, lease_token = gen_random_uuid(),
            dead_at = CASE WHEN attempts + 1 = max_attempts THEN lease_until END
          WHERE tenant_id = tenant AND queue_id = q.queue_id AND message_id = msg.message_id RETURNING * INTO msg;
          IF msg.dead_at IS NOT NULL THEN reason := 'final_attempt'; END IF;
          result := jsonb_build_object('messageId', msg.message_id, 'payload', msg.payload_json::jsonb,
            'attempt', msg.attempts, 'leaseToken', msg.lease_token, 'leaseExpiresAt', msg.available_at);
        ELSE
          reason := 'queue_empty';
        END IF;
        result := jsonb_build_object('message', result);

      WHEN 'ack', 'nack' THEN
        SELECT * INTO msg FROM queue_messages WHERE tenant_id = tenant AND queue_id = q.queue_id
          AND message_id = target_id FOR UPDATE;
        now_at := clock_timestamp();
        IF NOT FOUND OR msg.lease_app_id IS DISTINCT FROM actor OR msg.lease_token IS DISTINCT FROM (payload->>'leaseToken')::uuid
          OR msg.available_at <= now_at THEN
          PERFORM audit_append('audit.queue_' || operation, 'audit', q.queue_id, 0, 'failed', 'queue_lease_lost');
          RETURN record_error(409, 'queue_lease_lost');
        END IF;
        IF operation = 'ack' THEN
          UPDATE queue_messages SET payload_json = NULL, dead_at = NULL, lease_app_id = NULL, lease_token = NULL
          WHERE tenant_id = tenant AND queue_id = q.queue_id AND message_id = target_id;
        ELSE
          IF msg.attempts = msg.max_attempts THEN reason := 'attempts_exhausted'; END IF;
          UPDATE queue_messages SET available_at = now_at + make_interval(secs => (1 << (msg.attempts - 1))),
            dead_at = CASE WHEN reason IS NOT NULL THEN now_at END, lease_app_id = NULL, lease_token = NULL
          WHERE tenant_id = tenant AND queue_id = q.queue_id AND message_id = target_id;
        END IF;
        status := 204;

      WHEN 'list' THEN
        page_limit := (payload->>'limit')::integer;
        page_cursor := (payload->>'cursor')::uuid;
        WITH page AS (
          SELECT * FROM queue_messages WHERE tenant_id = tenant AND queue_id = q.queue_id
            AND dead_at <= statement_timestamp() AND (page_cursor IS NULL OR message_id > page_cursor)
          ORDER BY message_id LIMIT page_limit + 1
        ), items AS (SELECT * FROM page ORDER BY message_id LIMIT page_limit)
        SELECT jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object('messageId', message_id,
          'payload', payload_json::jsonb, 'attempt', attempts, 'deadLetteredAt', dead_at,
          'reason', CASE WHEN lease_token IS NULL THEN 'nack' ELSE 'lease_expired' END) ORDER BY message_id), '[]'::jsonb),
          'nextCursor', CASE WHEN (SELECT count(*) FROM page) > page_limit THEN max(message_id::text) END)
        INTO result FROM items;

      WHEN 'replay' THEN
        UPDATE queue_messages SET available_at = clock_timestamp(), dead_at = NULL, lease_app_id = NULL,
          lease_token = NULL, attempts = 0, max_attempts = q.max_attempts
        WHERE tenant_id = tenant AND queue_id = q.queue_id AND message_id = target_id AND dead_at <= clock_timestamp()
        RETURNING * INTO msg;
        IF NOT FOUND THEN
          PERFORM audit_append('audit.queue_replay', 'audit', q.queue_id, 0, 'failed', 'dead_letter_not_found');
          RETURN record_error(404, 'dead_letter_not_found');
        END IF;
        status := 204;
    END CASE;
  END IF;

  PERFORM audit_append('audit.queue_' || operation, 'audit', coalesce(msg.message_id, q.queue_id),
    coalesce(msg.attempts, 0), 'success', reason);
  RETURN jsonb_build_object('status', status, 'value', result);
END $$;

REVOKE ALL ON FUNCTION core.queue_command(text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.queue_command(text, text, jsonb) TO junctura_queue_api;
RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (65) ON CONFLICT DO NOTHING;
NOTIFY pgrst, 'reload schema';
COMMIT;
