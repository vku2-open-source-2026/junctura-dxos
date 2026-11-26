-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;

ALTER TABLE core.app_records ADD COLUMN archived_at timestamptz;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

CREATE FUNCTION app_private.record_guard_archived() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF OLD.archived_at IS NOT NULL THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE='record_archived';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE FUNCTION app_private.record_archive_row(p_actor uuid,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,app_private,pg_temp SET timezone='UTC' AS $$
DECLARE
  tenant text := record_tenant();
  collection_name text := p_payload->>'collection';
  r core.app_records;
  failure jsonb;
  claims jsonb := current_setting('request.jwt.claims',true)::jsonb;
BEGIN
  IF claims ? 'human_app_id' AND NOT coalesce(claims->'app_roles' ? 'manager',false) THEN
    RETURN record_error(403,'write_forbidden');
  END IF;
  IF coalesce(collection_name,'') !~ '^[a-z][a-z0-9_-]{0,62}$'
    OR coalesce(p_payload->>'id','') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN
    RETURN record_error(400,'invalid_request');
  END IF;
  PERFORM record_lock_collection(p_actor,collection_name);
  SELECT * INTO r FROM core.app_records WHERE tenant_id=tenant AND owner_app_id=p_actor
    AND collection=collection_name AND id=(p_payload->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RETURN record_error(404,'not_found'); END IF;
  failure:=record_before_write(r,p_payload->>'ifMatch',true);
  IF failure IS NOT NULL THEN RETURN failure; END IF;
  IF r.version=9007199254740991 THEN RETURN record_error(409,'resource_conflict'); END IF;
  UPDATE core.app_records SET archived_at=clock_timestamp(),version=version+1
    WHERE tenant_id=tenant AND id=r.id RETURNING * INTO r;
  DELETE FROM record_locks WHERE tenant_id=tenant AND record_id=r.id;
  PERFORM audit_append('audit.record_archived','audit',r.id,0,'success','lifecycle',claims->>'request_id');
  RETURN jsonb_build_object('status',200,'headers',jsonb_build_object('ETag',record_etag(r.tenant_id,r.owner_app_id,r.collection,r.id,r.incarnation,r.version)),
    'value',jsonb_build_object('id',r.id,'collection',r.collection,'version',r.version,'archivedAt',r.archived_at));
END $$;

CREATE FUNCTION app_private.record_audit_archived(p_id uuid,p_source text) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,app_private,pg_temp AS $$
DECLARE
  claims jsonb := current_setting('request.jwt.claims',true)::jsonb;
BEGIN
  IF EXISTS (SELECT FROM core.app_records WHERE tenant_id=record_tenant() AND id=p_id
    AND archived_at IS NOT NULL) THEN
    PERFORM audit_append('audit.archived_record_read','audit',p_id,0,'success',p_source,claims->>'request_id');
  END IF;
  RETURN true;
END $$;

-- Read paths share masking after their authorization and selection. Application
-- archive exports use the same function for each returned snapshot line.
DO $$
DECLARE change record; definition text;
BEGIN
  FOR change IN SELECT * FROM (VALUES
    ('app_private.record_before_write(core.app_records,text,boolean)', E'BEGIN\n  IF lease.lock_id',
      E'BEGIN\n  IF p_record.archived_at IS NOT NULL THEN RETURN record_error(409,''record_archived''); END IF;\n  IF lease.lock_id'),
    ('app_private.record_lock_command(uuid,text,uuid,uuid,integer,boolean)', '  checked_at := clock_timestamp();',
      '  IF r.archived_at IS NOT NULL THEN RETURN record_error(409,''record_archived''); END IF; checked_at := clock_timestamp();'),
    ('app_private.record_apply(text,uuid,jsonb)', E'BEGIN\n',
      E'BEGIN\n  IF p_operation = ''archive_row'' THEN RETURN record_archive_row(p_actor,p_payload); END IF;\n'),
    ('app_private.record_mask_data(uuid,text,uuid,text,jsonb,text)', E'BEGIN\n',
      E'BEGIN\n  PERFORM record_audit_archived(p_id,''record_read'');\n'),
    ('app_private.record_response(integer,core.app_records,text)', $old$p_record.id, p_record.consent_subject, p_record.data, p_scope) END))$old$,
      $new$p_record.id, p_record.consent_subject, p_record.data, p_scope) END) ||
        jsonb_strip_nulls(jsonb_build_object('archivedAt',p_record.archived_at)))$new$),
    ('app_private.record_legacy_list(jsonb)', $old$r.consent_subject, r.data, 'shared')))$old$,
      $new$r.consent_subject, r.data, 'shared')) ||
        jsonb_strip_nulls(jsonb_build_object('archivedAt',r.archived_at)))$new$),
    ('app_private.record_query_list_read(uuid,jsonb)', $old$r.version, r.data, r.consent_subject, perm.scope$old$,
      $new$r.version, r.data, r.consent_subject, r.archived_at, perm.scope$new$),
    ('app_private.record_query_list_read(uuid,jsonb)', $old$'version', record_row.version, 'data', data_out$old$,
      $new$'version', record_row.version, 'data', data_out) ||
      jsonb_strip_nulls(jsonb_build_object('archivedAt',record_row.archived_at)$new$),
    ('core.search_command(text,jsonb)', $old$'id',r.id))$old$,
      $new$'id',r.id),'archived',r.archived_at IS NOT NULL)$new$),
    ('core.search_command(text,jsonb)', 'WHERE item IS NOT NULL;',
      $new$WHERE item IS NOT NULL AND (NOT coalesce((payload->>'auditArchived')::boolean,false)
        OR NOT coalesce((item->>'archived')::boolean,false)
        OR record_audit_archived((item->'recordRef'->>'id')::uuid,'record_search'));$new$)
  ) AS v(signature,old_text,new_text) LOOP
    definition:=pg_get_functiondef(change.signature::regprocedure);
    IF strpos(definition,change.old_text)=0 THEN RAISE EXCEPTION 'Unexpected record lifecycle anchor for %',change.signature; END IF;
    EXECUTE replace(definition,change.old_text,change.new_text);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION app_private.record_guard_archived(),app_private.record_archive_row(uuid,jsonb),
  app_private.record_audit_archived(uuid,text) FROM PUBLIC;

RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
CREATE TRIGGER record_guard_archived BEFORE UPDATE OR DELETE ON core.app_records
  FOR EACH ROW EXECUTE FUNCTION app_private.record_guard_archived();
INSERT INTO core.schema_migrations(version) VALUES (69);
NOTIFY pgrst,'reload schema';
COMMIT;
