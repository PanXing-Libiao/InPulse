SET LOCAL ROLE app_owner;

-- ADR-109：移除功能层，任务与迭代记录直接归属模块。
-- 本迁移是一次性破坏性拆除：先上提历史功能级数据，再删除功能专属列、关系、表、
-- 搜索投影与编号序列；审计、项目动态、通知和历史快照不删除。
-- 回退必须使用迁移前备份，旧版本 API/Web 不得直连迁移后的数据库。

DROP FUNCTION IF EXISTS app.hard_delete_task(INTEGER, INTEGER, INTEGER, INTEGER, TEXT);
DROP FUNCTION IF EXISTS app.hard_delete_module(INTEGER, INTEGER, INTEGER, INTEGER, TEXT);
DROP FUNCTION IF EXISTS app.hard_delete_feature(INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, TEXT);
DROP FUNCTION IF EXISTS app.hard_delete_business_scope(INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, TEXT);
DROP FUNCTION IF EXISTS app.purge_project(INTEGER);

-- 功能层退出搜索；搜索跳转只需模块，任务不再带功能列。
DELETE FROM app.search_projection WHERE entity_type = 'FEATURE';
ALTER TABLE app.search_projection
  DROP CONSTRAINT IF EXISTS search_projection_navigation_shape_check,
  DROP CONSTRAINT IF EXISTS search_projection_feature_project_fk,
  DROP CONSTRAINT IF EXISTS search_projection_entity_type_check,
  DROP COLUMN IF EXISTS feature_id;
ALTER TABLE app.search_projection
  ADD CONSTRAINT search_projection_entity_type_check
    CHECK (entity_type IN (
      'PROJECT', 'MODULE', 'TASK', 'CHANGE_RECORD', 'EXTERNAL_LINK',
      'TASK_GROUP', 'LEFTOVER'
    )),
  ADD CONSTRAINT search_projection_navigation_shape_check
    CHECK (
      (module_id IS NULL OR entity_type = 'TASK')
      AND (record_id IS NULL OR entity_type = 'LEFTOVER')
    );

-- 功能编号停止发放；历史编号已随功能实体删除，不再保留不可达序列。
DELETE FROM app.code_sequences WHERE entity_type = 'FEATURE';
ALTER TABLE app.code_sequences
  DROP CONSTRAINT IF EXISTS code_sequences_entity_check;
ALTER TABLE app.code_sequences
  ADD CONSTRAINT code_sequences_entity_check
    CHECK (entity_type IN ('TASK', 'CHANGE_RECORD', 'TASK_GROUP', 'MODULE'));

-- 能力字段改为模块编辑 / 删除，三档取值与默认值不变。
ALTER TABLE app.project_member_permission_settings
  RENAME COLUMN module_feature_edit TO module_edit;
ALTER TABLE app.project_member_permission_settings
  RENAME COLUMN module_feature_delete TO module_delete;
ALTER TABLE app.project_member_permission_settings
  RENAME CONSTRAINT project_member_permission_settings_module_feature_edit_check
    TO project_member_permission_settings_module_edit_check;
ALTER TABLE app.project_member_permission_settings
  RENAME CONSTRAINT project_member_permission_settings_module_feature_delete_check
    TO project_member_permission_settings_module_delete_check;
COMMENT ON COLUMN app.project_member_permission_settings.module_edit IS
  'ADR-109：模块及其直属任务的普通编辑能力档位。';
COMMENT ON COLUMN app.project_member_permission_settings.module_delete IS
  'ADR-109：模块物理删除能力档位；删除级联模块下任务与记录。';

-- 文档导入模板由 项目 -> 模块 -> 功能 -> 任务 收敛为 项目 -> 模块 -> 任务。
-- 历史批次保留 template_version = '1'；新批次写入 '2'。功能计数列退出历史记录结构。
ALTER TABLE app.document_import_runs
  DROP CONSTRAINT IF EXISTS document_import_runs_counts_check,
  DROP CONSTRAINT IF EXISTS document_import_runs_template_version_check;
ALTER TABLE app.document_import_runs
  DROP COLUMN IF EXISTS feature_count,
  DROP COLUMN IF EXISTS reused_feature_count;
ALTER TABLE app.document_import_runs
  ADD CONSTRAINT document_import_runs_template_version_check
    CHECK (template_version IN ('1', '2')),
  ADD CONSTRAINT document_import_runs_counts_check
    CHECK (
      module_count >= 0
      AND task_count >= 0
      AND reused_module_count >= 0
      AND added_member_count >= 0
    );

-- 已发布记录也必须上提，因此临时停用 USER 触发器；外键系统触发器仍生效。
ALTER TABLE app.tasks DISABLE TRIGGER USER;
UPDATE app.tasks
   SET feature_id = NULL,
       scope_type = 'MODULE'
 WHERE feature_id IS NOT NULL OR scope_type = 'FEATURE';
ALTER TABLE app.tasks ENABLE TRIGGER USER;

ALTER TABLE app.change_records DISABLE TRIGGER USER;
UPDATE app.change_records
   SET feature_id = NULL,
       scope_type = 'MODULE'
 WHERE feature_id IS NOT NULL OR scope_type = 'FEATURE';
ALTER TABLE app.change_records ENABLE TRIGGER USER;

ALTER TABLE app.tasks
  DROP CONSTRAINT IF EXISTS tasks_feature_module_project_fk,
  DROP CONSTRAINT IF EXISTS tasks_scope_feature_check,
  DROP CONSTRAINT IF EXISTS tasks_scope_check,
  DROP COLUMN IF EXISTS feature_id,
  DROP COLUMN IF EXISTS scope_type;

ALTER TABLE app.change_records
  DROP CONSTRAINT IF EXISTS change_records_feature_module_project_fk,
  DROP CONSTRAINT IF EXISTS change_records_scope_feature_check,
  DROP CONSTRAINT IF EXISTS change_records_scope_check,
  DROP COLUMN IF EXISTS feature_id,
  DROP COLUMN IF EXISTS scope_type;

-- 记录发布后仍允许草稿阶段确定模块，但不再有功能 scope 可切换。
CREATE OR REPLACE FUNCTION app.protect_change_record_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.author_id IS DISTINCT FROM OLD.author_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'change record identity is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.code IS NOT NULL AND NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'a published change record code is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.task_id IS NOT NULL AND NEW.task_id IS DISTINCT FROM OLD.task_id THEN
    RAISE EXCEPTION 'an established change record task link is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status <> 'DRAFT' AND NEW.module_id IS DISTINCT FROM OLD.module_id THEN
    RAISE EXCEPTION 'published change record module is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$function$;

DROP TABLE IF EXISTS app.task_feature_impacts;
DROP TABLE IF EXISTS app.change_record_feature_impacts;
DROP TABLE IF EXISTS app.feature_external_links;
DROP FUNCTION IF EXISTS app.require_module_scope_impact();
DROP TABLE IF EXISTS app.features;

-- 0026 的草稿删除函数仍引用已移除的功能影响表；函数体在 PL/pgSQL 中延迟解析，
-- 不会阻止功能表删除，但运行时会 500。这里以同一签名重建函数，保留草稿窄口和权限。
CREATE OR REPLACE FUNCTION app.delete_change_record_draft(
  p_project_id INTEGER,
  p_record_id INTEGER,
  p_expected_row_version INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
DECLARE
  target app.change_records%ROWTYPE;
BEGIN
  SELECT *
    INTO target
    FROM app.change_records
   WHERE id = p_record_id
     AND project_id = p_project_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;
  IF target.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'change record % is not a draft', p_record_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF target.row_version <> p_expected_row_version THEN
    RETURN FALSE;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM app.change_record_leftover_items
     WHERE record_id = p_record_id
       AND project_id = p_project_id
  ) THEN
    RAISE EXCEPTION 'draft change record % has leftover items', p_record_id
      USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM app.change_record_external_links
   WHERE change_record_id = p_record_id
     AND project_id = p_project_id;
  DELETE FROM app.change_records
   WHERE id = p_record_id
     AND project_id = p_project_id
     AND status = 'DRAFT';
  RETURN TRUE;
END
$function$;

REVOKE ALL ON FUNCTION app.delete_change_record_draft(INTEGER, INTEGER, INTEGER)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.delete_change_record_draft(INTEGER, INTEGER, INTEGER)
  TO app_runtime;


-- 物理删除窄口：功能层移除后，删除根只剩模块或任务。
CREATE FUNCTION app.hard_delete_business_scope(
  p_project_id INTEGER,
  p_module_id INTEGER,
  p_task_id INTEGER,
  p_actor_id INTEGER,
  p_reason TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app'
AS $function$
DECLARE
  v_removed INTEGER;
  v_links INTEGER := 0;
BEGIN
  IF p_project_id IS NULL OR p_project_id <= 0 THEN
    RAISE EXCEPTION 'project id must be a positive integer'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_actor_id IS NULL OR p_actor_id <= 0 THEN
    RAISE EXCEPTION 'actor id must be a positive integer'
      USING ERRCODE = 'check_violation';
  END IF;
  IF ((p_module_id IS NOT NULL)::INTEGER + (p_task_id IS NOT NULL)::INTEGER) <> 1 THEN
    RAISE EXCEPTION 'exactly one delete root is required'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'delete reason must not be empty'
      USING ERRCODE = 'check_violation';
  END IF;

  DROP TABLE IF EXISTS pg_temp.hd_tasks;
  DROP TABLE IF EXISTS pg_temp.hd_records;
  DROP TABLE IF EXISTS pg_temp.hd_leftovers;
  DROP TABLE IF EXISTS pg_temp.hd_groups;

  CREATE TEMP TABLE hd_tasks ON COMMIT DROP AS
  SELECT t.id
    FROM app.tasks AS t
   WHERE t.project_id = p_project_id
     AND (
       (p_task_id IS NOT NULL AND t.id = p_task_id)
       OR (p_module_id IS NOT NULL AND t.module_id = p_module_id)
     );

  PERFORM t.id
    FROM app.tasks AS t
   WHERE t.id IN (SELECT id FROM pg_temp.hd_tasks)
   ORDER BY t.id
     FOR UPDATE;

  CREATE TEMP TABLE hd_groups ON COMMIT DROP AS
  SELECT DISTINCT gm.group_id
    FROM app.task_group_members AS gm
    JOIN pg_temp.hd_tasks AS t ON t.id = gm.task_id
   WHERE gm.project_id = p_project_id
     AND gm.status = 'ACTIVE';

  PERFORM tg.id
    FROM app.task_groups AS tg
   WHERE tg.id IN (SELECT group_id FROM pg_temp.hd_groups)
   ORDER BY tg.id
     FOR UPDATE;

  CREATE TEMP TABLE hd_records ON COMMIT DROP AS
  SELECT r.id
    FROM app.change_records AS r
   WHERE r.project_id = p_project_id
     AND (
       (p_task_id IS NOT NULL AND r.task_id = p_task_id)
       OR r.task_id IN (SELECT id FROM pg_temp.hd_tasks)
       OR (p_module_id IS NOT NULL AND r.module_id = p_module_id)
     );

  PERFORM r.id
    FROM app.change_records AS r
   WHERE r.id IN (SELECT id FROM pg_temp.hd_records)
   ORDER BY r.id
     FOR UPDATE;

  CREATE TEMP TABLE hd_leftovers ON COMMIT DROP AS
  SELECT i.id
    FROM app.change_record_leftover_items AS i
   WHERE i.project_id = p_project_id
     AND i.record_id IN (SELECT id FROM pg_temp.hd_records);

  PERFORM i.id
    FROM app.change_record_leftover_items AS i
   WHERE i.id IN (SELECT id FROM pg_temp.hd_leftovers)
   ORDER BY i.id
     FOR UPDATE;

  DELETE FROM app.leftover_task_links AS l
   USING pg_temp.hd_tasks AS t
   WHERE l.task_id = t.id AND l.project_id = p_project_id;

  DELETE FROM app.leftover_task_links AS l
   USING pg_temp.hd_leftovers AS i
   WHERE l.leftover_item_id = i.id AND l.project_id = p_project_id;

  DELETE FROM app.change_record_version_leftovers AS v
   USING pg_temp.hd_records AS r
   WHERE v.record_id = r.id AND v.project_id = p_project_id;

  DELETE FROM app.change_record_external_links AS x
   USING pg_temp.hd_records AS r
   WHERE x.change_record_id = r.id AND x.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_links := v_links + v_removed;

  DELETE FROM app.change_record_versions AS v
   USING pg_temp.hd_records AS r
   WHERE v.record_id = r.id AND v.project_id = p_project_id;

  DELETE FROM app.change_record_leftover_items AS i
   USING pg_temp.hd_records AS r
   WHERE i.record_id = r.id AND i.project_id = p_project_id;

  DELETE FROM app.change_records AS r
   USING pg_temp.hd_records AS d
   WHERE r.id = d.id AND r.project_id = p_project_id;

  UPDATE app.task_group_members AS gm
     SET status = 'DETACHED',
         detached_at = GREATEST(clock_timestamp(), gm.joined_at),
         detached_by = p_actor_id,
         detach_reason = p_reason
    FROM pg_temp.hd_groups AS g
   WHERE gm.group_id = g.group_id
     AND gm.project_id = p_project_id
     AND gm.status = 'ACTIVE';

  DELETE FROM app.task_group_members AS gm
   USING pg_temp.hd_tasks AS t
   WHERE gm.task_id = t.id AND gm.project_id = p_project_id;

  UPDATE app.task_groups AS tg
     SET status = 'CLOSED',
         closed_at = GREATEST(clock_timestamp(), tg.created_at),
         row_version = tg.row_version + 1,
         updated_at = GREATEST(clock_timestamp(), tg.updated_at)
    FROM pg_temp.hd_groups AS g
   WHERE tg.id = g.group_id
     AND tg.project_id = p_project_id
     AND tg.status = 'ACTIVE';

  DELETE FROM app.task_groups AS tg
   USING pg_temp.hd_groups AS g
   WHERE tg.id = g.group_id
     AND tg.project_id = p_project_id
     AND NOT EXISTS (
       SELECT 1
         FROM app.task_group_members AS gm
        WHERE gm.group_id = tg.id AND gm.project_id = tg.project_id
     );

  DELETE FROM app.task_status_history AS h
   USING pg_temp.hd_tasks AS t
   WHERE h.task_id = t.id AND h.project_id = p_project_id;

  DELETE FROM app.task_assignees AS a
   USING pg_temp.hd_tasks AS t
   WHERE a.task_id = t.id AND a.project_id = p_project_id;

  DELETE FROM app.task_external_links AS x
   USING pg_temp.hd_tasks AS t
   WHERE x.task_id = t.id AND x.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_links := v_links + v_removed;

  DELETE FROM app.tasks AS t
   USING pg_temp.hd_tasks AS d
   WHERE t.id = d.id AND t.project_id = p_project_id;

  IF p_module_id IS NOT NULL THEN
    DELETE FROM app.modules AS m
     WHERE m.id = p_module_id
       AND m.project_id = p_project_id
       AND m.kind = 'NORMAL';
    GET DIAGNOSTICS v_removed = ROW_COUNT;
    IF v_removed <> 1 THEN
      RAISE EXCEPTION 'normal module % was not deleted', p_module_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  DELETE FROM app.search_projection AS s
   USING pg_temp.hd_tasks AS t
   WHERE s.entity_type = 'TASK' AND s.entity_id = t.id AND s.project_id = p_project_id;

  DELETE FROM app.search_projection AS s
   USING pg_temp.hd_records AS r
   WHERE s.entity_type = 'CHANGE_RECORD' AND s.entity_id = r.id AND s.project_id = p_project_id;

  DELETE FROM app.search_projection AS s
   USING pg_temp.hd_leftovers AS i
   WHERE s.entity_type = 'LEFTOVER' AND s.entity_id = i.id AND s.project_id = p_project_id;

  DELETE FROM app.search_projection AS s
   USING pg_temp.hd_groups AS g
   WHERE s.entity_type = 'TASK_GROUP' AND s.entity_id = g.group_id AND s.project_id = p_project_id;

  IF p_module_id IS NOT NULL THEN
    DELETE FROM app.search_projection AS s
     WHERE s.entity_type = 'MODULE'
       AND s.entity_id = p_module_id
       AND s.project_id = p_project_id;
  END IF;

  RETURN jsonb_build_object(
    'deletedTaskCount', (SELECT count(*)::INTEGER FROM pg_temp.hd_tasks),
    'deletedRecordCount', (SELECT count(*)::INTEGER FROM pg_temp.hd_records),
    'removedLinkCount', v_links
  );
END
$function$;

CREATE FUNCTION app.hard_delete_task(
  p_project_id INTEGER,
  p_task_id INTEGER,
  p_expected_row_version INTEGER,
  p_actor_id INTEGER,
  p_reason TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app'
AS $function$
DECLARE
  v_task app.tasks%ROWTYPE;
  v_role TEXT;
  v_group_id INTEGER;
  v_counts jsonb;
BEGIN
  SELECT * INTO v_task
    FROM app.tasks AS t
   WHERE t.project_id = p_project_id
     AND t.id = p_task_id
     AND t.deleted_at IS NULL
     FOR UPDATE;
  IF NOT FOUND OR v_task.row_version <> p_expected_row_version THEN
    RETURN NULL;
  END IF;

  SELECT gm.role, gm.group_id INTO v_role, v_group_id
    FROM app.task_group_members AS gm
    JOIN app.task_groups AS tg
      ON tg.id = gm.group_id AND tg.project_id = gm.project_id
   WHERE gm.project_id = p_project_id
     AND gm.task_id = p_task_id
     AND gm.status = 'ACTIVE'
     AND tg.status = 'ACTIVE'
   ORDER BY gm.id
   LIMIT 1;

  v_counts := app.hard_delete_business_scope(
    p_project_id, NULL, p_task_id, p_actor_id, p_reason
  );

  RETURN jsonb_build_object(
    'id', v_task.id,
    'projectId', v_task.project_id,
    'moduleId', v_task.module_id,
    'code', v_task.code,
    'title', v_task.title,
    'workStatus', v_task.work_status,
    'detachedGroupRole', v_role,
    'detachedGroupId', v_group_id,
    'deletedAt', clock_timestamp(),
    'deletedRecordCount', (v_counts ->> 'deletedRecordCount')::INTEGER,
    'removedLinkCount', (v_counts ->> 'removedLinkCount')::INTEGER
  );
END
$function$;

CREATE FUNCTION app.hard_delete_module(
  p_project_id INTEGER,
  p_module_id INTEGER,
  p_expected_row_version INTEGER,
  p_actor_id INTEGER,
  p_reason TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app'
AS $function$
DECLARE
  v_module app.modules%ROWTYPE;
  v_counts jsonb;
BEGIN
  SELECT * INTO v_module
    FROM app.modules AS m
   WHERE m.project_id = p_project_id
     AND m.id = p_module_id
     AND m.deleted_at IS NULL
     FOR UPDATE;
  IF NOT FOUND OR v_module.row_version <> p_expected_row_version THEN
    RETURN NULL;
  END IF;
  IF v_module.kind <> 'NORMAL' THEN
    RAISE EXCEPTION 'the unclassified module cannot be deleted'
      USING ERRCODE = 'check_violation';
  END IF;

  v_counts := app.hard_delete_business_scope(
    p_project_id, p_module_id, NULL, p_actor_id, p_reason
  );

  RETURN jsonb_build_object(
    'id', v_module.id,
    'projectId', v_module.project_id,
    'code', v_module.code,
    'name', v_module.name,
    'kind', v_module.kind,
    'deletedAt', clock_timestamp(),
    'deletedTaskCount', (v_counts ->> 'deletedTaskCount')::INTEGER,
    'deletedRecordCount', (v_counts ->> 'deletedRecordCount')::INTEGER,
    'removedLinkCount', (v_counts ->> 'removedLinkCount')::INTEGER
  );
END
$function$;

REVOKE ALL ON FUNCTION app.hard_delete_business_scope(INTEGER, INTEGER, INTEGER, INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.hard_delete_task(INTEGER, INTEGER, INTEGER, INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.hard_delete_module(INTEGER, INTEGER, INTEGER, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.hard_delete_task(INTEGER, INTEGER, INTEGER, INTEGER, TEXT) TO app_runtime;
GRANT EXECUTE ON FUNCTION app.hard_delete_module(INTEGER, INTEGER, INTEGER, INTEGER, TEXT) TO app_runtime;

-- ADR-085 的审计链保留逻辑保持不变；只移除功能相关删除与返回值。
CREATE FUNCTION app.purge_project(p_project_id INTEGER)
RETURNS TABLE (
  modules INTEGER,
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
           v_tasks,
           v_change_records,
           v_audit_logs,
           v_members,
           v_total;
END;
$function$;

REVOKE ALL ON FUNCTION app.purge_project(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_project(INTEGER) TO app_runtime;

DO $$
DECLARE
  missing_function TEXT;
  bad_owner TEXT;
  runtime_execute BOOLEAN;
  public_execute BOOLEAN;
  helper_execute BOOLEAN;
  purge_definition TEXT;
BEGIN
  IF to_regclass('app.features') IS NOT NULL
     OR to_regclass('app.task_feature_impacts') IS NOT NULL
     OR to_regclass('app.change_record_feature_impacts') IS NOT NULL
     OR to_regclass('app.feature_external_links') IS NOT NULL THEN
    RAISE EXCEPTION 'feature-layer tables still exist';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'app'
       AND (
         (table_name = 'tasks' AND column_name IN ('feature_id', 'scope_type'))
         OR (table_name = 'change_records' AND column_name IN ('feature_id', 'scope_type'))
         OR (table_name = 'search_projection' AND column_name = 'feature_id')
       )
  ) THEN
    RAISE EXCEPTION 'feature-layer columns still exist';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM app.search_projection
     WHERE entity_type = 'FEATURE'
  ) OR EXISTS (
    SELECT 1
      FROM app.code_sequences
     WHERE entity_type = 'FEATURE'
  ) THEN
    RAISE EXCEPTION 'feature-layer projection or sequence still exists';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'app'
       AND table_name = 'project_member_permission_settings'
       AND column_name = 'module_edit'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'app'
       AND table_name = 'project_member_permission_settings'
       AND column_name = 'module_delete'
  ) THEN
    RAISE EXCEPTION 'module permission columns are missing';
  END IF;

  SELECT string_agg(required.name, ', ')
    INTO missing_function
    FROM (VALUES
      ('hard_delete_business_scope'),
      ('hard_delete_task'),
      ('hard_delete_module'),
      ('purge_project')
    ) AS required(name)
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND p.proname = required.name
   );
  IF missing_function IS NOT NULL THEN
    RAISE EXCEPTION 'missing deletion function(s): %', missing_function;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'app'
       AND p.proname IN ('hard_delete_feature')
  ) THEN
    RAISE EXCEPTION 'feature deletion function still exists';
  END IF;

  SELECT string_agg(p.proname, ', ')
    INTO bad_owner
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app'
     AND p.proname IN ('hard_delete_business_scope','hard_delete_task','hard_delete_module','purge_project')
     AND (pg_get_userbyid(p.proowner) <> 'app_owner' OR NOT p.prosecdef);
  IF bad_owner IS NOT NULL THEN
    RAISE EXCEPTION 'deletion function ownership/security is wrong: %', bad_owner;
  END IF;

  SELECT has_function_privilege('app_runtime', 'app.hard_delete_task(integer,integer,integer,integer,text)', 'EXECUTE')
     AND has_function_privilege('app_runtime', 'app.hard_delete_module(integer,integer,integer,integer,text)', 'EXECUTE')
     AND has_function_privilege('app_runtime', 'app.purge_project(integer)', 'EXECUTE')
    INTO runtime_execute;
  SELECT has_function_privilege('public', 'app.hard_delete_task(integer,integer,integer,integer,text)', 'EXECUTE')
      OR has_function_privilege('public', 'app.hard_delete_module(integer,integer,integer,integer,text)', 'EXECUTE')
      OR has_function_privilege('public', 'app.purge_project(integer)', 'EXECUTE')
    INTO public_execute;
  SELECT has_function_privilege('app_runtime', 'app.hard_delete_business_scope(integer,integer,integer,integer,text)', 'EXECUTE')
    INTO helper_execute;
  IF NOT runtime_execute OR public_execute OR helper_execute THEN
    RAISE EXCEPTION 'deletion execute grants are wrong';
  END IF;

  SELECT pg_get_functiondef(p.oid)
    INTO purge_definition
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app' AND p.proname = 'purge_project';
  IF purge_definition LIKE '%app.features%'
     OR purge_definition LIKE '%feature_external_links%'
     OR purge_definition LIKE '%task_feature_impacts%'
     OR purge_definition LIKE '%change_record_feature_impacts%' THEN
    RAISE EXCEPTION 'purge_project still references the feature layer';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'app'
       AND p.proname IN ('hard_delete_business_scope','hard_delete_task','hard_delete_module')
       AND (pg_get_functiondef(p.oid) LIKE '%DELETE FROM app.audit_logs%'
            OR pg_get_functiondef(p.oid) LIKE '%DELETE FROM app.activity_projection%'
            OR pg_get_functiondef(p.oid) LIKE '%DELETE FROM app.notifications%')
  ) THEN
    RAISE EXCEPTION 'hard delete must not remove audit, activity or notifications';
  END IF;
END
$$;
