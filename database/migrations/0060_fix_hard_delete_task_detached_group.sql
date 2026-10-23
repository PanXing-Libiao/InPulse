SET LOCAL ROLE app_owner;

-- ADR-096 修正：0059 在删除成员关系后才读取 group_id，导致 detachedGroupId 恒为 NULL。
-- 不修改历史迁移，只替换入口函数并在同一行锁读取中缓存角色与组 ID。

CREATE OR REPLACE FUNCTION app.hard_delete_task(
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
    'detachedGroupId', v_group_id,
    'deletedAt', clock_timestamp(),
    'deletedRecordCount', (v_counts ->> 'deletedRecordCount')::INTEGER,
    'removedLinkCount', (v_counts ->> 'removedLinkCount')::INTEGER
  );
END
$function$;

REVOKE ALL ON FUNCTION app.hard_delete_task(INTEGER, INTEGER, INTEGER, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.hard_delete_task(INTEGER, INTEGER, INTEGER, INTEGER, TEXT) TO app_runtime;
