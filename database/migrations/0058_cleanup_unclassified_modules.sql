SET LOCAL ROLE app_owner;

-- ADR-095: 删除历史遗留的全部未分类模块及其业务下级。
-- 保留审计、项目动态和项目成员关系；不保留迭代记录或其快照。
-- 使用临时表固定清理范围，避免逐层删除时子查询漂移。

CREATE TEMP TABLE purge_modules ON COMMIT DROP AS
SELECT m.id, m.project_id, m.created_by
FROM app.modules m
WHERE m.kind = $q$UNCLASSIFIED$q$;

CREATE UNIQUE INDEX purge_modules_pk ON purge_modules (id, project_id);

CREATE TEMP TABLE purge_features ON COMMIT DROP AS
SELECT f.id, f.module_id, f.project_id
FROM app.features f
JOIN purge_modules m ON m.id = f.module_id AND m.project_id = f.project_id;

CREATE UNIQUE INDEX purge_features_pk ON purge_features (id, project_id);

CREATE TEMP TABLE purge_tasks ON COMMIT DROP AS
SELECT t.id, t.module_id, t.project_id
FROM app.tasks t
JOIN purge_modules m ON m.id = t.module_id AND m.project_id = t.project_id;

CREATE UNIQUE INDEX purge_tasks_pk ON purge_tasks (id, project_id);

CREATE TEMP TABLE purge_records ON COMMIT DROP AS
SELECT r.id, r.module_id, r.project_id
FROM app.change_records r
JOIN purge_modules m ON m.id = r.module_id AND m.project_id = r.project_id;

CREATE UNIQUE INDEX purge_records_pk ON purge_records (id, project_id);

CREATE TEMP TABLE purge_leftovers ON COMMIT DROP AS
SELECT i.id, i.record_id, i.project_id
FROM app.change_record_leftover_items i
JOIN purge_records r ON r.id = i.record_id AND r.project_id = i.project_id;

CREATE UNIQUE INDEX purge_leftovers_pk ON purge_leftovers (id, project_id);

CREATE TEMP TABLE purge_groups ON COMMIT DROP AS
SELECT gm.group_id, gm.project_id, min(m.created_by) AS detached_by
FROM app.task_group_members gm
JOIN purge_tasks t ON t.id = gm.task_id AND t.project_id = gm.project_id
JOIN purge_modules m ON m.id = t.module_id AND m.project_id = t.project_id
GROUP BY gm.group_id, gm.project_id;

CREATE UNIQUE INDEX purge_groups_pk ON purge_groups (group_id, project_id);

-- 未分类模块的历史保护触发器只在本次迁移事务内关闭，提交前恢复。
ALTER TABLE app.modules DISABLE TRIGGER modules_protect_unclassified;

DELETE FROM app.leftover_task_links l
USING purge_tasks t
WHERE l.task_id = t.id AND l.project_id = t.project_id;

DELETE FROM app.leftover_task_links l
USING purge_leftovers x
WHERE l.leftover_item_id = x.id AND l.project_id = x.project_id;

DELETE FROM app.change_record_version_leftovers v
USING purge_records r
WHERE v.record_id = r.id AND v.project_id = r.project_id;

DELETE FROM app.change_record_external_links x
USING purge_records r
WHERE x.change_record_id = r.id AND x.project_id = r.project_id;

DELETE FROM app.change_record_feature_impacts i
USING purge_records r
WHERE i.change_record_id = r.id AND i.project_id = r.project_id;

DELETE FROM app.change_record_feature_impacts i
USING purge_features f
WHERE i.feature_id = f.id
  AND i.module_id = f.module_id
  AND i.project_id = f.project_id;

DELETE FROM app.change_record_versions v
USING purge_records r
WHERE v.record_id = r.id AND v.project_id = r.project_id;

DELETE FROM app.change_record_leftover_items i
USING purge_records r
WHERE i.record_id = r.id AND i.project_id = r.project_id;

DELETE FROM app.change_records r
USING purge_records p
WHERE r.id = p.id AND r.project_id = p.project_id;

DELETE FROM app.task_group_members gm
USING purge_tasks t
WHERE gm.task_id = t.id AND gm.project_id = t.project_id;

-- 跨模块聚合组：删除未分类任务后，剩余分支保留任务，但组必须退出活跃态。
UPDATE app.task_group_members gm
SET status = $q$DETACHED$q$,
    detached_at = GREATEST(clock_timestamp(), gm.joined_at),
    detached_by = g.detached_by,
    detach_reason = $q$所属未分类模块已清理$q$
FROM purge_groups g
WHERE gm.group_id = g.group_id
  AND gm.project_id = g.project_id
  AND gm.status = $q$ACTIVE$q$;

UPDATE app.task_groups tg
SET status = $q$CLOSED$q$,
    closed_at = GREATEST(clock_timestamp(), tg.created_at),
    row_version = tg.row_version + 1,
    updated_at = GREATEST(clock_timestamp(), tg.updated_at)
FROM purge_groups g
WHERE tg.id = g.group_id
  AND tg.project_id = g.project_id
  AND EXISTS (
    SELECT 1
    FROM app.task_group_members gm
    WHERE gm.group_id = tg.id AND gm.project_id = tg.project_id
  );

DELETE FROM app.task_groups tg
USING purge_groups g
WHERE tg.id = g.group_id
  AND tg.project_id = g.project_id
  AND NOT EXISTS (
    SELECT 1
    FROM app.task_group_members gm
    WHERE gm.group_id = tg.id AND gm.project_id = tg.project_id
  );

DELETE FROM app.task_feature_impacts i
USING purge_tasks t
WHERE i.task_id = t.id AND i.project_id = t.project_id;

DELETE FROM app.task_feature_impacts i
USING purge_features f
WHERE i.feature_id = f.id
  AND i.module_id = f.module_id
  AND i.project_id = f.project_id;

DELETE FROM app.task_status_history h
USING purge_tasks t
WHERE h.task_id = t.id AND h.project_id = t.project_id;

DELETE FROM app.task_assignees a
USING purge_tasks t
WHERE a.task_id = t.id AND a.project_id = t.project_id;

DELETE FROM app.task_external_links x
USING purge_tasks t
WHERE x.task_id = t.id AND x.project_id = t.project_id;

DELETE FROM app.tasks t
USING purge_tasks p
WHERE t.id = p.id AND t.project_id = p.project_id;

DELETE FROM app.feature_external_links x
USING purge_features f
WHERE x.feature_id = f.id AND x.project_id = f.project_id;

DELETE FROM app.features f
USING purge_features p
WHERE f.id = p.id AND f.project_id = p.project_id;

DELETE FROM app.modules m
USING purge_modules p
WHERE m.id = p.id AND m.project_id = p.project_id;

DELETE FROM app.search_projection s
USING purge_modules p
WHERE s.entity_type = $q$MODULE$q$
  AND s.entity_id = p.id
  AND s.project_id = p.project_id;

DELETE FROM app.search_projection s
USING purge_features p
WHERE s.entity_type = $q$FEATURE$q$
  AND s.entity_id = p.id
  AND s.project_id = p.project_id;

DELETE FROM app.search_projection s
USING purge_tasks p
WHERE s.entity_type = $q$TASK$q$
  AND s.entity_id = p.id
  AND s.project_id = p.project_id;

DELETE FROM app.search_projection s
USING purge_records p
WHERE s.entity_type = $q$CHANGE_RECORD$q$
  AND s.entity_id = p.id
  AND s.project_id = p.project_id;

DELETE FROM app.search_projection s
USING purge_leftovers p
WHERE s.entity_type = $q$LEFTOVER$q$
  AND s.entity_id = p.id
  AND s.project_id = p.project_id;

DELETE FROM app.search_projection s
USING purge_groups p
WHERE s.entity_type = $q$TASK_GROUP$q$
  AND s.entity_id = p.group_id
  AND s.project_id = p.project_id;

-- 结算本事务内的延迟约束事件后再恢复触发器。
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE app.modules ENABLE TRIGGER modules_protect_unclassified;

DO $body$
DECLARE
  remaining_modules INTEGER;
  remaining_features INTEGER;
  remaining_tasks INTEGER;
  remaining_records INTEGER;
  remaining_leftovers INTEGER;
  remaining_group_members INTEGER;
  remaining_active_groups INTEGER;
BEGIN
  SELECT count(*) INTO remaining_modules
  FROM app.modules
  WHERE kind = $q$UNCLASSIFIED$q$;

  SELECT count(*) INTO remaining_features
  FROM app.features f
  JOIN purge_modules p ON p.id = f.module_id AND p.project_id = f.project_id;

  SELECT count(*) INTO remaining_tasks
  FROM app.tasks t
  JOIN purge_modules p ON p.id = t.module_id AND p.project_id = t.project_id;

  SELECT count(*) INTO remaining_records
  FROM app.change_records r
  JOIN purge_modules p ON p.id = r.module_id AND p.project_id = r.project_id;

  SELECT count(*) INTO remaining_leftovers
  FROM app.change_record_leftover_items i
  JOIN purge_records p ON p.id = i.record_id AND p.project_id = i.project_id;

  SELECT count(*) INTO remaining_group_members
  FROM app.task_group_members gm
  JOIN purge_tasks p ON p.id = gm.task_id AND p.project_id = gm.project_id;

  SELECT count(*) INTO remaining_active_groups
  FROM app.task_groups g
  JOIN purge_groups p ON p.group_id = g.id AND p.project_id = g.project_id
  WHERE g.status = $q$ACTIVE$q$;

  IF remaining_modules <> 0 OR remaining_features <> 0 OR remaining_tasks <> 0
     OR remaining_records <> 0 OR remaining_leftovers <> 0
     OR remaining_group_members <> 0 OR remaining_active_groups <> 0
  THEN
    RAISE EXCEPTION $msg$unclassified cleanup left rows: modules %, features %, tasks %, records %, leftovers %, group members %, active groups %$msg$,
      remaining_modules, remaining_features, remaining_tasks, remaining_records,
      remaining_leftovers, remaining_group_members, remaining_active_groups;
  END IF;
END
$body$;
