-- SPDX-FileCopyrightText: 2026 Junctura Contributors
-- SPDX-License-Identifier: Apache-2.0
BEGIN;
GRANT CREATE ON SCHEMA core TO junctura_app_owner;
SET LOCAL ROLE junctura_app_owner;

CREATE OR REPLACE FUNCTION app_private.audit_filter_error(p_filter jsonb,p_view jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,app_private,pg_temp AS $$
  SELECT CASE
    WHEN p_view IS NULL THEN record_error(403,'audit_permission_required')
    WHEN p_filter ? 'unit' AND NOT (p_view->>'mode'='management'
      OR (p_view->>'mode'='regulator' AND (p_view->'units') ? (p_filter->>'unit')))
      THEN record_error(403,'audit_permission_required')
    WHEN p_filter ? 'subjectId' AND p_view->>'mode'='management' THEN record_error(403,'audit_permission_required')
  END
$$;

CREATE OR REPLACE FUNCTION app_private.audit_filter(a app_private.audit,entry jsonb,p_filter jsonb,p_view jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT (NOT p_filter ? 'action' OR p_filter->>'action'=coalesce(entry->>'action',a.event))
    AND (NOT p_filter ? 'subjectId' OR (entry->>'subjectId'=p_filter->>'subjectId'
      AND (p_view->>'mode'='app' OR entry->>'sensitivity'='standard')))
    AND (NOT p_filter ? 'unit' OR entry->>'unit'=p_filter->>'unit')
    -- A match must not reveal actors from redacted application events.
    AND (NOT p_filter ? 'actor' OR (a.subject=p_filter->>'actor'
      AND (a.schema_version=1 OR p_view->>'mode'='app'
        OR (p_view->>'mode'='regulator' AND entry->>'sensitivity'='standard'))))
$$;

DO $migration$
DECLARE source text; updated text;
BEGIN
  source:=pg_get_functiondef('core.audit_query(jsonb)'::regprocedure);
  updated:=replace(source,$old$'app','action','subjectId','unit','from','to','since','until','limit','cursor'$old$,
    $new$'app','action','actor','subjectId','unit','from','to','since','until','limit','cursor'$new$);
  IF updated=source THEN RAISE EXCEPTION 'Unexpected audit query parameters'; END IF;
  EXECUTE updated;
END $migration$;

RESET ROLE;
REVOKE CREATE ON SCHEMA core FROM junctura_app_owner;
INSERT INTO core.schema_migrations(version) VALUES(66);
NOTIFY pgrst,'reload schema';
COMMIT;
