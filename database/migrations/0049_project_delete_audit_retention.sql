-- ADR-085：项目物理删除保留项目审计链。

-- 业务数据仍按 ADR-062 物理删除；项目自己的 PROJECT:<id> 审计日志与链头
-- 作为不可变历史保留。为此移除审计表到 app.projects 的外键，但保留
-- project_id / chain_id 的一致性 CHECK；项目 ID 仍不复用。
--
-- 本迁移同时重定义 app.purge_project：
--   1. 不再 DELETE app.audit_logs / app.audit_chain_heads；
--   2. 返回值中的 audit_logs 改为“保留的审计行数”，total 只统计删除的业务行；
--   3. 其余删除顺序、窄口与单行断言保持不变。

SET LOCAL ROLE app_owner;

ALTER TABLE app.audit_logs
  DROP CONSTRAINT IF EXISTS audit_logs_project_id_projects_id_fk;

ALTER TABLE app.audit_chain_heads
  DROP CONSTRAINT IF EXISTS audit_chain_heads_project_id_projects_id_fk;

CREATE OR REPLACE FUNCTION app.purge_project(p_project_id INTEGER)
 RETURNS TABLE (
   modules INTEGER,
   features INTEGER,
   tasks INTEGER,
   change_records INTEGER,
   audit_logs INTEGER,
   members INTEGER,
   total INTEGER
 )
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app'
AS $function$
DECLARE
  v_removed INTEGER;
  v_modules INTEGER := 0;
  v_features INTEGER := 0;
  v_tasks INTEGER := 0;
  v_change_records INTEGER := 0;
  v_audit_logs INTEGER := 0;
  v_members INTEGER := 0;
  v_total INTEGER := 0;
BEGIN
  IF p_project_id IS NULL OR p_project_id <= 0 THEN
    RAISE EXCEPTION 'project id must be a positive integer'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM app.projects p
     WHERE p.id = p_project_id
     FOR UPDATE
  ) THEN
    RAISE EXCEPTION 'project % not found', p_project_id
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('app.purge_project_id', p_project_id::text, true);

  -- ADR-085：项目链与链头保留；这里只统计随项目冻结的历史审计行数。
  SELECT count(*)::INTEGER
    INTO v_audit_logs
    FROM app.audit_logs
   WHERE project_id = p_project_id;

  DELETE FROM app.change_record_version_leftovers r WHERE r.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_total := v_total + v_removed;

  DELETE FROM app.change_record_external_links r WHERE r.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_total := v_total + v_removed;

  DELETE FROM app.change_record_feature_impacts r WHERE r.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_total := v_total + v_removed;

  DELETE FROM app.change_record_versions r WHERE r.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_total := v_total + v_removed;

  DELETE FROM app.leftover_task_links r WHERE r.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_total := v_total + v_removed;

  DELETE FROM app.change_record_leftover_items r WHERE r.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_total := v_total + v_removed;

  DELETE FROM app.change_records r WHERE r.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_change_records := v_change_records + v_removed;
  v_total := v_total + v_removed;

  DELETE FROM app.task_feature_impacts r WHERE r.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_total := v_total + v_removed;

  DELETE FROM app.task_group_members r WHERE r.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_total := v_total + v_removed;

  DELETE FROM app.task_status_history r WHERE r.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_total := v_total + v_removed;

  DELETE FROM app.task_assignees r WHERE r.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_total := v_total + v_removed;

  DELETE FROM app.task_external_links r WHERE r.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_total := v_total + v_removed;

  DELETE FROM app.tasks r WHERE r.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_tasks := v_tasks + v_removed;
  v_total := v_total + v_removed;

  DELETE FROM app.task_groups r WHERE r.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_total := v_total + v_removed;

  DELETE FROM app.feature_external_links r WHERE r.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_total := v_total + v_removed;

  DELETE FROM app.features r WHERE r.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_features := v_features + v_removed;
  v_total := v_total + v_removed;

  DELETE FROM app.project_external_links r WHERE r.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_total := v_total + v_removed;

  DELETE FROM app.modules m WHERE m.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_modules := v_modules + v_removed;
  v_total := v_total + v_removed;

  DELETE FROM app.project_archive_requests r WHERE r.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_total := v_total + v_removed;

  DELETE FROM app.code_sequences r WHERE r.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_total := v_total + v_removed;

  DELETE FROM app.document_import_runs r WHERE r.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_total := v_total + v_removed;

  -- ADR-077：企微群投递记录与绑定行随项目一起物理删除，最后清待用码。
  DELETE FROM app.wecom_group_deliveries d
   USING app.project_wecom_groups g
   WHERE d.group_binding_id = g.id
     AND g.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_total := v_total + v_removed;

  DELETE FROM app.project_wecom_groups r WHERE r.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_total := v_total + v_removed;

  DELETE FROM app.project_wecom_binding_codes r WHERE r.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_total := v_total + v_removed;

  DELETE FROM app.project_members r WHERE r.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_members := v_members + v_removed;
  v_total := v_total + v_removed;

  DELETE FROM app.notifications r WHERE r.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_total := v_total + v_removed;

  DELETE FROM app.activity_projection r WHERE r.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_total := v_total + v_removed;

  DELETE FROM app.search_projection r WHERE r.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_total := v_total + v_removed;

  DELETE FROM app.external_links r WHERE r.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_total := v_total + v_removed;


  DELETE FROM app.projects r WHERE r.id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  IF v_removed <> 1 THEN
    RAISE EXCEPTION 'project % disappeared during purge', p_project_id;
  END IF;

  PERFORM set_config('app.purge_project_id', '', true);

  RETURN QUERY
    SELECT v_modules,
           v_features,
           v_tasks,
           v_change_records,
           v_audit_logs,
           v_members,
           v_total;
END;
$function$;

-- 部署校验：外键已移除、审计链未被 purge 删除、函数与只读权限保持。
DO $$
DECLARE
  fk_count INTEGER;
  purge_owner TEXT;
  purge_def TEXT;
  purge_security_definer BOOLEAN;
  runtime_execute BOOLEAN;
  public_execute BOOLEAN;
  audit_reader_ok BOOLEAN;
  archive_reader_ok BOOLEAN;
BEGIN
  SELECT count(*)::INTEGER
    INTO fk_count
    FROM pg_constraint
   WHERE (conrelid = 'app.audit_logs'::regclass
          AND conname = 'audit_logs_project_id_projects_id_fk')
      OR (conrelid = 'app.audit_chain_heads'::regclass
          AND conname = 'audit_chain_heads_project_id_projects_id_fk');
  IF fk_count <> 0 THEN
    RAISE EXCEPTION 'audit project foreign keys must be removed for ADR-085';
  END IF;

  SELECT pg_get_userbyid(p.proowner),
         pg_get_functiondef(p.oid),
         p.prosecdef
    INTO purge_owner, purge_def, purge_security_definer
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app'
     AND p.proname = 'purge_project';

  IF purge_owner IS NULL OR purge_owner <> 'app_owner' THEN
    RAISE EXCEPTION 'app.purge_project ownership check failed';
  END IF;
  IF NOT purge_security_definer THEN
    RAISE EXCEPTION 'app.purge_project must remain SECURITY DEFINER';
  END IF;
  IF position('DELETE FROM app.audit_logs' IN purge_def) <> 0
     OR position('DELETE FROM app.audit_chain_heads' IN purge_def) <> 0 THEN
    RAISE EXCEPTION 'app.purge_project must not delete audit history';
  END IF;
  IF position('SELECT count(*)::INTEGER' IN purge_def) = 0
     OR position('INTO v_audit_logs' IN purge_def) = 0
     OR position('project_wecom_groups' IN purge_def) = 0
     OR position('document_import_runs' IN purge_def) = 0 THEN
    RAISE EXCEPTION 'app.purge_project body is incomplete after ADR-085';
  END IF;

  SELECT has_function_privilege('app_runtime', 'app.purge_project(integer)', 'EXECUTE')
    INTO runtime_execute;
  SELECT has_function_privilege('public', 'app.purge_project(integer)', 'EXECUTE')
    INTO public_execute;
  IF NOT runtime_execute OR public_execute THEN
    RAISE EXCEPTION 'app.purge_project execute grants are wrong';
  END IF;

  SELECT has_table_privilege('audit_reader', 'app.audit_logs', 'SELECT')
     AND has_table_privilege('audit_reader', 'app.audit_chain_heads', 'SELECT')
    INTO audit_reader_ok;
  SELECT has_table_privilege('audit_archive_writer', 'app.audit_logs', 'SELECT')
     AND has_table_privilege('audit_archive_writer', 'app.audit_chain_heads', 'SELECT')
    INTO archive_reader_ok;
  IF NOT audit_reader_ok OR NOT archive_reader_ok THEN
    RAISE EXCEPTION 'audit readers must retain SELECT access';
  END IF;
END
$$;
