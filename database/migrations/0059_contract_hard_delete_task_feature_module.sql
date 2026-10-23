SET LOCAL ROLE app_owner;

-- ADR-096：任务、功能、模块删除改为物理删除，只保留审计、项目动态与删除事件。
-- app_runtime 没有业务表 DELETE 权限，因此物理级联收在 SECURITY DEFINER 窄口函数中。
-- 所有函数只接受项目内真实归属 ID，并在同一事务内完成全部下级清理。

CREATE FUNCTION app.hard_delete_business_scope(
  p_project_id INTEGER,
  p_module_id INTEGER,
  p_feature_id INTEGER,
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
  IF ((p_module_id IS NOT NULL)::INTEGER + (p_feature_id IS NOT NULL)::INTEGER
      + (p_task_id IS NOT NULL)::INTEGER) <> 1 THEN
    RAISE EXCEPTION 'exactly one delete root is required'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'delete reason must not be empty'
      USING ERRCODE = 'check_violation';
  END IF;

  -- 每次调用重建会话临时表，避免同一事务内的多次删除共用漂移后的范围。
  DROP TABLE IF EXISTS pg_temp.hd_tasks;
  DROP TABLE IF EXISTS pg_temp.hd_features;
  DROP TABLE IF EXISTS pg_temp.hd_records;
  DROP TABLE IF EXISTS pg_temp.hd_leftovers;
  DROP TABLE IF EXISTS pg_temp.hd_groups;

  -- 先按 ID 升序锁住父级功能，再锁任务、聚合组、迭代记录与遗留项，遵守固定锁序。
  IF p_module_id IS NOT NULL THEN
    PERFORM f.id
      FROM app.features AS f
     WHERE f.project_id = p_project_id
       AND f.module_id = p_module_id
     ORDER BY f.id
       FOR UPDATE;
  END IF;

  CREATE TEMP TABLE hd_tasks ON COMMIT DROP AS
  SELECT t.id
    FROM app.tasks AS t
   WHERE t.project_id = p_project_id
     AND (
       (p_task_id IS NOT NULL AND t.id = p_task_id)
       OR (p_feature_id IS NOT NULL AND t.feature_id = p_feature_id)
       OR (p_module_id IS NOT NULL AND t.module_id = p_module_id)
     );

  PERFORM t.id
    FROM app.tasks AS t
   WHERE t.id IN (SELECT id FROM pg_temp.hd_tasks)
   ORDER BY t.id
     FOR UPDATE;

  CREATE TEMP TABLE hd_features ON COMMIT DROP AS
  SELECT f.id
    FROM app.features AS f
   WHERE f.project_id = p_project_id
     AND (
       (p_feature_id IS NOT NULL AND f.id = p_feature_id)
       OR (p_module_id IS NOT NULL AND f.module_id = p_module_id)
     );

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
       OR (p_feature_id IS NOT NULL AND r.feature_id = p_feature_id)
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

  -- 任务下级与范围外仍指向这些任务的遗留项链接。
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

  DELETE FROM app.change_record_feature_impacts AS i
   USING pg_temp.hd_records AS r
   WHERE i.change_record_id = r.id AND i.project_id = p_project_id;

  DELETE FROM app.change_record_feature_impacts AS i
   USING pg_temp.hd_features AS f
   WHERE i.feature_id = f.id AND i.project_id = p_project_id;

  DELETE FROM app.change_record_versions AS v
   USING pg_temp.hd_records AS r
   WHERE v.record_id = r.id AND v.project_id = p_project_id;

  DELETE FROM app.change_record_leftover_items AS i
   USING pg_temp.hd_records AS r
   WHERE i.record_id = r.id AND i.project_id = p_project_id;

  DELETE FROM app.change_records AS r
   USING pg_temp.hd_records AS d
   WHERE r.id = d.id AND r.project_id = p_project_id;

  -- 聚合组：任何包含被删活跃任务的组都退出活跃态；剩余成员解除关系，空组删除。
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

  DELETE FROM app.task_feature_impacts AS i
   USING pg_temp.hd_tasks AS t
   WHERE i.task_id = t.id AND i.project_id = p_project_id;

  DELETE FROM app.task_feature_impacts AS i
   USING pg_temp.hd_features AS f
   WHERE i.feature_id = f.id AND i.project_id = p_project_id;

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

  DELETE FROM app.feature_external_links AS x
   USING pg_temp.hd_features AS f
   WHERE x.feature_id = f.id AND x.project_id = p_project_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_links := v_links + v_removed;

  DELETE FROM app.features AS f
   USING pg_temp.hd_features AS d
   WHERE f.id = d.id AND f.project_id = p_project_id;

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

  -- 搜索投影随实体物理删除；外部链接主表保留，只清关联行。
  DELETE FROM app.search_projection AS s
   USING pg_temp.hd_tasks AS t
   WHERE s.entity_type = 'TASK' AND s.entity_id = t.id AND s.project_id = p_project_id;

  DELETE FROM app.search_projection AS s
   USING pg_temp.hd_features AS f
   WHERE s.entity_type = 'FEATURE' AND s.entity_id = f.id AND s.project_id = p_project_id;

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
    'deletedFeatureCount', (SELECT count(*)::INTEGER FROM pg_temp.hd_features),
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

  SELECT gm.role INTO v_role
    FROM app.task_group_members AS gm
    JOIN app.task_groups AS tg
      ON tg.id = gm.group_id AND tg.project_id = gm.project_id
   WHERE gm.project_id = p_project_id
     AND gm.task_id = p_task_id
     AND gm.status = 'ACTIVE'
   ORDER BY gm.id
   LIMIT 1;

  v_counts := app.hard_delete_business_scope(
    p_project_id, NULL, NULL, p_task_id, p_actor_id, p_reason
  );

  RETURN jsonb_build_object(
    'id', v_task.id,
    'projectId', v_task.project_id,
    'moduleId', v_task.module_id,
    'featureId', v_task.feature_id,
    'code', v_task.code,
    'title', v_task.title,
    'workStatus', v_task.work_status,
    'detachedGroupRole', v_role,
    'detachedGroupId', (
      SELECT gm.group_id
        FROM app.task_group_members AS gm
       WHERE gm.project_id = p_project_id
         AND gm.task_id = p_task_id
       LIMIT 1
    ),
    'deletedAt', clock_timestamp(),
    'deletedRecordCount', (v_counts ->> 'deletedRecordCount')::INTEGER,
    'removedLinkCount', (v_counts ->> 'removedLinkCount')::INTEGER
  );
END
$function$;

CREATE FUNCTION app.hard_delete_feature(
  p_project_id INTEGER,
  p_module_id INTEGER,
  p_feature_id INTEGER,
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
  v_feature app.features%ROWTYPE;
  v_counts jsonb;
BEGIN
  SELECT * INTO v_feature
    FROM app.features AS f
   WHERE f.project_id = p_project_id
     AND f.module_id = p_module_id
     AND f.id = p_feature_id
     AND f.deleted_at IS NULL
     FOR UPDATE;
  IF NOT FOUND OR v_feature.row_version <> p_expected_row_version THEN
    RETURN NULL;
  END IF;

  v_counts := app.hard_delete_business_scope(
    p_project_id, NULL, p_feature_id, NULL, p_actor_id, p_reason
  );

  RETURN jsonb_build_object(
    'id', v_feature.id,
    'projectId', v_feature.project_id,
    'moduleId', v_feature.module_id,
    'code', v_feature.code,
    'name', v_feature.name,
    'deletedAt', clock_timestamp(),
    'deletedTaskCount', (v_counts ->> 'deletedTaskCount')::INTEGER,
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
    p_project_id, p_module_id, NULL, NULL, p_actor_id, p_reason
  );

  RETURN jsonb_build_object(
    'id', v_module.id,
    'projectId', v_module.project_id,
    'code', v_module.code,
    'name', v_module.name,
    'kind', v_module.kind,
    'deletedAt', clock_timestamp(),
    'deletedFeatureCount', (v_counts ->> 'deletedFeatureCount')::INTEGER,
    'deletedTaskCount', (v_counts ->> 'deletedTaskCount')::INTEGER,
    'deletedRecordCount', (v_counts ->> 'deletedRecordCount')::INTEGER,
    'removedLinkCount', (v_counts ->> 'removedLinkCount')::INTEGER
  );
END
$function$;

REVOKE ALL ON FUNCTION app.hard_delete_business_scope(INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.hard_delete_task(INTEGER, INTEGER, INTEGER, INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.hard_delete_feature(INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.hard_delete_module(INTEGER, INTEGER, INTEGER, INTEGER, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.hard_delete_task(INTEGER, INTEGER, INTEGER, INTEGER, TEXT) TO app_runtime;
GRANT EXECUTE ON FUNCTION app.hard_delete_feature(INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, TEXT) TO app_runtime;
GRANT EXECUTE ON FUNCTION app.hard_delete_module(INTEGER, INTEGER, INTEGER, INTEGER, TEXT) TO app_runtime;

DO $$
DECLARE
  missing TEXT;
  bad_owner TEXT;
  runtime_execute BOOLEAN;
  public_execute BOOLEAN;
  helper_execute BOOLEAN;
BEGIN
  SELECT string_agg(required.name, ', ')
    INTO missing
    FROM (VALUES
      ('hard_delete_business_scope'),
      ('hard_delete_task'),
      ('hard_delete_feature'),
      ('hard_delete_module')
    ) AS required(name)
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND p.proname = required.name
   );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'missing hard delete function(s): %', missing;
  END IF;

  SELECT string_agg(p.proname, ', ')
    INTO bad_owner
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app'
     AND p.proname IN ('hard_delete_business_scope','hard_delete_task','hard_delete_feature','hard_delete_module')
     AND (pg_get_userbyid(p.proowner) <> 'app_owner' OR NOT p.prosecdef);
  IF bad_owner IS NOT NULL THEN
    RAISE EXCEPTION 'hard delete function ownership/security is wrong: %', bad_owner;
  END IF;

  SELECT has_function_privilege('app_runtime', 'app.hard_delete_task(integer,integer,integer,integer,text)', 'EXECUTE')
     AND has_function_privilege('app_runtime', 'app.hard_delete_feature(integer,integer,integer,integer,integer,text)', 'EXECUTE')
     AND has_function_privilege('app_runtime', 'app.hard_delete_module(integer,integer,integer,integer,text)', 'EXECUTE')
    INTO runtime_execute;
  SELECT has_function_privilege('public', 'app.hard_delete_task(integer,integer,integer,integer,text)', 'EXECUTE')
      OR has_function_privilege('public', 'app.hard_delete_feature(integer,integer,integer,integer,integer,text)', 'EXECUTE')
      OR has_function_privilege('public', 'app.hard_delete_module(integer,integer,integer,integer,text)', 'EXECUTE')
    INTO public_execute;
  SELECT has_function_privilege('app_runtime', 'app.hard_delete_business_scope(integer,integer,integer,integer,integer,text)', 'EXECUTE')
    INTO helper_execute;
  IF NOT runtime_execute OR public_execute OR helper_execute THEN
    RAISE EXCEPTION 'hard delete execute grants are wrong';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'app'
       AND p.proname IN ('hard_delete_business_scope','hard_delete_task','hard_delete_feature','hard_delete_module')
       AND (pg_get_functiondef(p.oid) LIKE '%DELETE FROM app.audit_logs%'
            OR pg_get_functiondef(p.oid) LIKE '%DELETE FROM app.activity_projection%'
            OR pg_get_functiondef(p.oid) LIKE '%DELETE FROM app.notifications%')
  ) THEN
    RAISE EXCEPTION 'hard delete must not remove audit, activity or notifications';
  END IF;
END
$$;
