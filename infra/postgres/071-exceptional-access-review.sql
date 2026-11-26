-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

CREATE TABLE app_private.exceptional_review_groups (
  tenant_id text PRIMARY KEY,
  unit text NOT NULL,
  unit_group text NOT NULL,
  FOREIGN KEY (tenant_id,unit,unit_group)
    REFERENCES app_private.directory_groups(tenant_id,unit,unit_group) ON DELETE CASCADE
);
ALTER TABLE app_private.exceptional_review_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.exceptional_review_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app_private.exceptional_review_groups TO junctura_app_owner
  USING (tenant_id=app_private.record_tenant());

CREATE TABLE execution_private.exceptional_review_tasks (
  tenant_id text NOT NULL,
  execution_id uuid NOT NULL,
  accessed_at timestamptz NOT NULL,
  CONSTRAINT exceptional_review_task_pkey PRIMARY KEY (tenant_id,execution_id),
  FOREIGN KEY (tenant_id,execution_id) REFERENCES execution_private.emergency_reviews(tenant_id,execution_id) ON DELETE CASCADE
);
ALTER TABLE execution_private.exceptional_review_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_private.exceptional_review_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON execution_private.exceptional_review_tasks TO junctura_app_owner
  USING (tenant_id=app_private.record_tenant());

CREATE FUNCTION execution_private.enqueue_exceptional_review() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,app_private,pg_temp AS $$
DECLARE previous text:=current_setting('request.jwt.claims',true);
BEGIN
  INSERT INTO execution_private.exceptional_review_tasks(tenant_id,execution_id,accessed_at)
    SELECT r.tenant_id,r.execution_id,NEW.ticket_consumed_at FROM execution_private.emergency_reviews r
    WHERE (r.tenant_id,r.execution_id)=(NEW.tenant_id,NEW.execution_id)
    ON CONFLICT DO NOTHING;
  IF FOUND THEN
    PERFORM set_config('request.jwt.claims',jsonb_build_object('tenant_id',NEW.tenant_id,
      'iss',NEW.issuer,'sub',NEW.initiating_subject,'client_id',NEW.initiating_client)::text,true);
    PERFORM audit_append('execution.exceptional_review_queued','execution',NEW.execution_id,0);
    PERFORM set_config('request.jwt.claims',coalesce(previous,''),true);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER enqueue_exceptional_review AFTER UPDATE OF ticket_consumed_at ON execution_private.executions
  FOR EACH ROW WHEN (OLD.ticket_consumed_at IS NULL AND NEW.ticket_consumed_at IS NOT NULL)
  EXECUTE FUNCTION execution_private.enqueue_exceptional_review();

CREATE FUNCTION core.exceptional_review(operation text,payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private,pg_temp SET timezone='UTC' AS $$
DECLARE
  tenant text:=record_tenant();
  claims jsonb:=current_setting('request.jwt.claims',true)::jsonb;
  review execution_private.emergency_reviews;
  listing jsonb;
  requested text:=payload->>'decision';
  reason text:=btrim(payload->>'reason');
  resulting text;
BEGIN
  IF NOT EXISTS (SELECT FROM principals p WHERE p.tenant_id=tenant AND p.issuer=claims->>'iss'
      AND p.subject=claims->>'sub' AND p.management_client=claims->>'client_id'
      AND p.enabled AND p.permissions @> ARRAY['audit.read']) OR
     NOT EXISTS (SELECT FROM exceptional_review_groups binding
       JOIN directory_groups g USING (tenant_id,unit,unit_group)
       JOIN directory_units u USING (tenant_id,unit)
       WHERE binding.tenant_id=tenant AND NOT g.pending_delete AND NOT u.pending_delete
         AND claims->'groups' ? ('/' || binding.unit || '/' || binding.unit_group)) THEN
    RETURN record_error(403,'exceptional_review_required');
  END IF;

  IF operation='list' THEN
    SELECT coalesce(jsonb_agg(item ORDER BY accessed_at DESC,execution_id),'[]'::jsonb) INTO listing FROM (
      SELECT t.accessed_at,t.execution_id,jsonb_build_object('taskId',t.execution_id,
        'executionId',t.execution_id,'state',CASE r.state WHEN 'justified' THEN 'valid' WHEN 'unjustified' THEN 'invalid' ELSE r.state END,
        'actor',e.initiating_subject,'capabilityId',e.capability_id,'subjectId',ctx.data_subject,
        'accessedAt',t.accessed_at,'justification',ctx.justification,'reviewedAt',r.reviewed_at,'reason',r.note) AS item
      FROM execution_private.exceptional_review_tasks t
      JOIN execution_private.executions e USING (tenant_id,execution_id)
      JOIN execution_private.execution_contexts ctx USING (tenant_id,execution_id)
      JOIN execution_private.emergency_reviews r USING (tenant_id,execution_id)
      WHERE t.tenant_id=tenant AND e.issuer=claims->>'iss'
      ORDER BY t.accessed_at DESC,t.execution_id LIMIT 200
    ) AS items;
    RETURN jsonb_build_object('status',200,'value',jsonb_build_object('tasks',listing));
  END IF;

  IF operation<>'review' OR coalesce(payload->>'executionId','') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
    OR coalesce(requested,'') NOT IN ('valid','invalid') OR jsonb_typeof(payload->'reason') IS DISTINCT FROM 'string'
    OR coalesce(length(reason),0) NOT BETWEEN 1 AND 500 OR reason ~ '[[:cntrl:]]' THEN
    RETURN record_error(400,'invalid_exceptional_review');
  END IF;
  resulting:=CASE requested WHEN 'valid' THEN 'justified' ELSE 'unjustified' END;
  SELECT r.* INTO review FROM execution_private.exceptional_review_tasks t
    JOIN execution_private.executions e USING (tenant_id,execution_id)
    JOIN execution_private.emergency_reviews r USING (tenant_id,execution_id)
    WHERE t.tenant_id=tenant AND t.execution_id=(payload->>'executionId')::uuid AND e.issuer=claims->>'iss'
    FOR UPDATE OF r;
  IF NOT FOUND THEN RETURN record_error(404,'not_found'); END IF;
  IF review.state='pending' THEN
    UPDATE execution_private.emergency_reviews SET state=resulting,reviewer_subject=claims->>'sub',
      reviewer_client=claims->>'client_id',note=reason,reviewed_at=clock_timestamp(),revision=revision+1
      WHERE tenant_id=tenant AND execution_id=review.execution_id RETURNING * INTO review;
    PERFORM audit_append('execution.exceptional_reviewed','execution',review.execution_id,review.revision,
      CASE requested WHEN 'valid' THEN 'success' ELSE 'denied' END,requested);
  ELSIF review.state IS DISTINCT FROM resulting OR review.reviewer_subject IS DISTINCT FROM claims->>'sub'
    OR review.reviewer_client IS DISTINCT FROM claims->>'client_id' OR review.note IS DISTINCT FROM reason THEN
    RETURN record_error(409,'already_reviewed');
  END IF;
  RETURN jsonb_build_object('status',200,'value',jsonb_build_object('taskId',review.execution_id,
    'executionId',review.execution_id,'state',requested,'reviewedAt',review.reviewed_at));
END $$;

DO $$
DECLARE change record; definition text;
BEGIN
  FOR change IN SELECT * FROM (VALUES
    ('core.execution_command(text,jsonb)',
      $old$'emergency', CASE WHEN stored.emergency THEN true END$old$,
      $new$'emergency', CASE WHEN stored.emergency THEN true END,
            'exceptionalAccess', CASE WHEN stored.emergency THEN true END$new$),
    ('core.subject_access_command(text,jsonb)',
      $old$'emergency', x.emergency, 'review'$old$,
      $new$'emergency', x.emergency, 'exceptionalAccess', x.emergency, 'review'$new$)
  ) AS v(signature,old_text,new_text) LOOP
    definition:=pg_get_functiondef(change.signature::regprocedure);
    IF strpos(definition,change.old_text)=0 THEN RAISE EXCEPTION 'Unexpected exceptional access alias anchor'; END IF;
    EXECUTE replace(definition,change.old_text,change.new_text);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION core.exceptional_review(text,jsonb),execution_private.enqueue_exceptional_review() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.exceptional_review(text,jsonb) TO junctura_trust_api;
RESET ROLE;
-- Existing completed accesses gain the same review task using their observed redemption time.
INSERT INTO execution_private.exceptional_review_tasks(tenant_id,execution_id,accessed_at)
  SELECT r.tenant_id,r.execution_id,e.ticket_consumed_at
  FROM execution_private.emergency_reviews r JOIN execution_private.executions e USING (tenant_id,execution_id)
  WHERE e.ticket_consumed_at IS NOT NULL ON CONFLICT DO NOTHING;

REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES (71);
NOTIFY pgrst,'reload schema';
COMMIT;
