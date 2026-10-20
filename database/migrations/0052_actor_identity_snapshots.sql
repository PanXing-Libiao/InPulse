-- ADR-088：离职账号物理删除前的业务署名快照。

-- 审计与项目动态已分别由 ADR-086 / ADR-087 保存操作人身份。本迁移把其余需要
-- 长期保留的历史署名统一固化为 JSONB：{ id, name, loginName }。
-- 快照只用于展示和溯源，不参与授权、成员关系或负责人判定。

SET LOCAL ROLE app_owner;

-- 校验快照结构及其与历史用户坐标的一致性；p_user_id 为空时要求快照也为空。
CREATE OR REPLACE FUNCTION app.is_actor_identity_snapshot(
  p_snapshot JSONB,
  p_user_id INTEGER
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT CASE
    WHEN p_user_id IS NULL THEN p_snapshot IS NULL
    ELSE COALESCE(
      p_snapshot IS NOT NULL
      AND jsonb_typeof(p_snapshot) = 'object'
      AND pg_column_size(p_snapshot) <= 4096
      AND jsonb_typeof(p_snapshot->'id') = 'number'
      AND jsonb_typeof(p_snapshot->'name') = 'string'
      AND jsonb_typeof(p_snapshot->'loginName') = 'string'
      AND length(btrim(p_snapshot->>'name')) BETWEEN 1 AND 200
      AND length(btrim(p_snapshot->>'loginName')) BETWEEN 1 AND 100
      AND p_snapshot->>'id' = p_user_id::text,
      false
    )
  END
$function$;

REVOKE ALL ON FUNCTION app.is_actor_identity_snapshot(JSONB, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_actor_identity_snapshot(JSONB, INTEGER) TO app_runtime;

-- 在当前用户仍存在时读取稳定身份；调用方事务内用户缺失时 fail closed。
CREATE OR REPLACE FUNCTION app.read_actor_identity_snapshot(p_user_id INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path TO 'pg_catalog', 'app'
AS $function$
DECLARE
  v_snapshot JSONB;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT jsonb_build_object(
           'id', u.id,
           'name', u.name,
           'loginName', u.login_name
         )
    INTO v_snapshot
    FROM app.users AS u
   WHERE u.id = p_user_id;

  IF v_snapshot IS NULL THEN
    RAISE EXCEPTION 'user % is missing for actor identity snapshot', p_user_id
      USING ERRCODE = '23503';
  END IF;
  RETURN v_snapshot;
END
$function$;

REVOKE ALL ON FUNCTION app.read_actor_identity_snapshot(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_actor_identity_snapshot(INTEGER) TO app_runtime;

-- 统一触发器：TG_ARGV[0] 为用户坐标列，TG_ARGV[1] 为快照列。
-- 只在对应坐标列发生 INSERT 或 UPDATE 时刷新，避免普通业务更新改写历史。
CREATE OR REPLACE FUNCTION app.capture_actor_identity_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'app'
AS $function$
DECLARE
  v_user_id INTEGER;
  v_snapshot JSONB;
BEGIN
  v_user_id := NULLIF(to_jsonb(NEW) ->> TG_ARGV[0], '')::INTEGER;
  v_snapshot := app.read_actor_identity_snapshot(v_user_id);
  NEW := jsonb_populate_record(
    NEW,
    jsonb_build_object(TG_ARGV[1], v_snapshot)
  );
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION app.capture_actor_identity_snapshot() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.capture_actor_identity_snapshot() TO app_runtime;

ALTER TABLE app.projects
  ADD COLUMN created_by_snapshot JSONB;
ALTER TABLE app.project_members
  ADD COLUMN user_snapshot JSONB;
ALTER TABLE app.modules
  ADD COLUMN created_by_snapshot JSONB,
  ADD COLUMN deleted_by_snapshot JSONB;
ALTER TABLE app.features
  ADD COLUMN created_by_snapshot JSONB,
  ADD COLUMN deleted_by_snapshot JSONB;
ALTER TABLE app.tasks
  ADD COLUMN creator_snapshot JSONB,
  ADD COLUMN deleted_by_snapshot JSONB;
ALTER TABLE app.task_assignees
  ADD COLUMN user_snapshot JSONB;
ALTER TABLE app.task_status_history
  ADD COLUMN changed_by_snapshot JSONB;
ALTER TABLE app.task_groups
  ADD COLUMN created_by_snapshot JSONB;
ALTER TABLE app.task_group_members
  ADD COLUMN original_assignee_snapshot JSONB,
  ADD COLUMN detached_by_snapshot JSONB;
ALTER TABLE app.change_records
  ADD COLUMN handler_snapshot JSONB,
  ADD COLUMN author_snapshot JSONB;
ALTER TABLE app.change_record_versions
  ADD COLUMN created_by_snapshot JSONB;
ALTER TABLE app.change_record_leftover_items
  ADD COLUMN created_by_snapshot JSONB;
ALTER TABLE app.leftover_task_links
  ADD COLUMN created_by_snapshot JSONB;
ALTER TABLE app.external_links
  ADD COLUMN created_by_snapshot JSONB;
ALTER TABLE app.document_import_runs
  ADD COLUMN actor_snapshot JSONB;
ALTER TABLE app.ai_assist_settings
  ADD COLUMN updated_by_snapshot JSONB;
ALTER TABLE app.wecom_robot_config
  ADD COLUMN updated_by_snapshot JSONB;
ALTER TABLE app.project_wecom_binding_codes
  ADD COLUMN consumed_by_user_snapshot JSONB;
ALTER TABLE app.project_wecom_groups
  ADD COLUMN bound_by_snapshot JSONB;
ALTER TABLE app.project_archive_requests
  ADD COLUMN requested_by_snapshot JSONB,
  ADD COLUMN decided_by_snapshot JSONB;

-- 结构迁移不改写 row_version；临时关闭对应触发器，回填后再启用。
ALTER TABLE app.projects DISABLE TRIGGER projects_row_version;
ALTER TABLE app.modules DISABLE TRIGGER modules_row_version;
ALTER TABLE app.features DISABLE TRIGGER features_row_version;
ALTER TABLE app.tasks DISABLE TRIGGER tasks_row_version;
ALTER TABLE app.change_records DISABLE TRIGGER change_records_row_version;
ALTER TABLE app.change_record_leftover_items DISABLE TRIGGER change_record_leftovers_row_version;
ALTER TABLE app.task_groups DISABLE TRIGGER task_groups_row_version;

UPDATE app.projects
   SET created_by_snapshot = app.read_actor_identity_snapshot(created_by)
 WHERE created_by_snapshot IS NULL;

UPDATE app.project_members
   SET user_snapshot = app.read_actor_identity_snapshot(user_id)
 WHERE user_snapshot IS NULL;

UPDATE app.modules
   SET created_by_snapshot = app.read_actor_identity_snapshot(created_by),
       deleted_by_snapshot = app.read_actor_identity_snapshot(deleted_by)
 WHERE created_by_snapshot IS NULL
    OR (deleted_by IS NOT NULL AND deleted_by_snapshot IS NULL);

UPDATE app.features
   SET created_by_snapshot = app.read_actor_identity_snapshot(created_by),
       deleted_by_snapshot = app.read_actor_identity_snapshot(deleted_by)
 WHERE created_by_snapshot IS NULL
    OR (deleted_by IS NOT NULL AND deleted_by_snapshot IS NULL);

UPDATE app.tasks
   SET creator_snapshot = app.read_actor_identity_snapshot(creator_id),
       deleted_by_snapshot = app.read_actor_identity_snapshot(deleted_by)
 WHERE creator_snapshot IS NULL
    OR (deleted_by IS NOT NULL AND deleted_by_snapshot IS NULL);

UPDATE app.task_assignees
   SET user_snapshot = app.read_actor_identity_snapshot(user_id)
 WHERE user_snapshot IS NULL;

UPDATE app.task_status_history
   SET changed_by_snapshot = app.read_actor_identity_snapshot(changed_by)
 WHERE changed_by_snapshot IS NULL;

UPDATE app.task_groups
   SET created_by_snapshot = app.read_actor_identity_snapshot(created_by)
 WHERE created_by_snapshot IS NULL;

UPDATE app.task_group_members
   SET original_assignee_snapshot = app.read_actor_identity_snapshot(original_assignee_id),
       detached_by_snapshot = app.read_actor_identity_snapshot(detached_by)
 WHERE (original_assignee_id IS NOT NULL AND original_assignee_snapshot IS NULL)
    OR (detached_by IS NOT NULL AND detached_by_snapshot IS NULL);

UPDATE app.change_records
   SET handler_snapshot = app.read_actor_identity_snapshot(handler_id),
       author_snapshot = app.read_actor_identity_snapshot(author_id)
 WHERE handler_snapshot IS NULL OR author_snapshot IS NULL;

UPDATE app.change_record_versions
   SET created_by_snapshot = app.read_actor_identity_snapshot(created_by)
 WHERE created_by_snapshot IS NULL;

UPDATE app.change_record_leftover_items
   SET created_by_snapshot = app.read_actor_identity_snapshot(created_by)
 WHERE created_by_snapshot IS NULL;

UPDATE app.leftover_task_links
   SET created_by_snapshot = app.read_actor_identity_snapshot(created_by)
 WHERE created_by_snapshot IS NULL;

UPDATE app.external_links
   SET created_by_snapshot = app.read_actor_identity_snapshot(created_by)
 WHERE created_by_snapshot IS NULL;

UPDATE app.document_import_runs
   SET actor_snapshot = app.read_actor_identity_snapshot(actor_id)
 WHERE actor_snapshot IS NULL;

UPDATE app.ai_assist_settings
   SET updated_by_snapshot = app.read_actor_identity_snapshot(updated_by)
 WHERE updated_by_snapshot IS NULL;

UPDATE app.wecom_robot_config
   SET updated_by_snapshot = app.read_actor_identity_snapshot(updated_by)
 WHERE updated_by_snapshot IS NULL;

UPDATE app.project_wecom_binding_codes
   SET consumed_by_user_snapshot = app.read_actor_identity_snapshot(consumed_by_user_id)
 WHERE consumed_by_user_id IS NOT NULL
   AND consumed_by_user_snapshot IS NULL;

UPDATE app.project_wecom_groups
   SET bound_by_snapshot = app.read_actor_identity_snapshot(bound_by_user_id)
 WHERE bound_by_snapshot IS NULL;

UPDATE app.project_archive_requests
   SET requested_by_snapshot = app.read_actor_identity_snapshot(requested_by),
       decided_by_snapshot = app.read_actor_identity_snapshot(decided_by)
 WHERE requested_by_snapshot IS NULL
    OR (decided_by IS NOT NULL AND decided_by_snapshot IS NULL);

-- 回填会在 projects 等表上排队延迟约束触发器；必须先结算本事务的延迟事件，
-- 否则后续 ALTER TABLE 会报 pending trigger events。
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE app.projects ENABLE TRIGGER projects_row_version;
ALTER TABLE app.modules ENABLE TRIGGER modules_row_version;
ALTER TABLE app.features ENABLE TRIGGER features_row_version;
ALTER TABLE app.tasks ENABLE TRIGGER tasks_row_version;
ALTER TABLE app.change_records ENABLE TRIGGER change_records_row_version;
ALTER TABLE app.change_record_leftover_items ENABLE TRIGGER change_record_leftovers_row_version;
ALTER TABLE app.task_groups ENABLE TRIGGER task_groups_row_version;

ALTER TABLE app.projects
  ALTER COLUMN created_by_snapshot SET NOT NULL;
ALTER TABLE app.project_members
  ALTER COLUMN user_snapshot SET NOT NULL;
ALTER TABLE app.modules
  ALTER COLUMN created_by_snapshot SET NOT NULL;
ALTER TABLE app.features
  ALTER COLUMN created_by_snapshot SET NOT NULL;
ALTER TABLE app.tasks
  ALTER COLUMN creator_snapshot SET NOT NULL;
ALTER TABLE app.task_assignees
  ALTER COLUMN user_snapshot SET NOT NULL;
ALTER TABLE app.task_status_history
  ALTER COLUMN changed_by_snapshot SET NOT NULL;
ALTER TABLE app.task_groups
  ALTER COLUMN created_by_snapshot SET NOT NULL;
ALTER TABLE app.change_records
  ALTER COLUMN handler_snapshot SET NOT NULL,
  ALTER COLUMN author_snapshot SET NOT NULL;
ALTER TABLE app.change_record_versions
  ALTER COLUMN created_by_snapshot SET NOT NULL;
ALTER TABLE app.change_record_leftover_items
  ALTER COLUMN created_by_snapshot SET NOT NULL;
ALTER TABLE app.leftover_task_links
  ALTER COLUMN created_by_snapshot SET NOT NULL;
ALTER TABLE app.external_links
  ALTER COLUMN created_by_snapshot SET NOT NULL;
ALTER TABLE app.document_import_runs
  ALTER COLUMN actor_snapshot SET NOT NULL;
ALTER TABLE app.ai_assist_settings
  ALTER COLUMN updated_by_snapshot SET NOT NULL;
ALTER TABLE app.wecom_robot_config
  ALTER COLUMN updated_by_snapshot SET NOT NULL;
ALTER TABLE app.project_wecom_groups
  ALTER COLUMN bound_by_snapshot SET NOT NULL;
ALTER TABLE app.project_archive_requests
  ALTER COLUMN requested_by_snapshot SET NOT NULL;

ALTER TABLE app.projects
  ADD CONSTRAINT projects_created_by_snapshot_check
  CHECK (app.is_actor_identity_snapshot(created_by_snapshot, created_by));
ALTER TABLE app.project_members
  ADD CONSTRAINT project_members_user_snapshot_check
  CHECK (app.is_actor_identity_snapshot(user_snapshot, user_id));
ALTER TABLE app.modules
  ADD CONSTRAINT modules_created_by_snapshot_check
  CHECK (app.is_actor_identity_snapshot(created_by_snapshot, created_by)),
  ADD CONSTRAINT modules_deleted_by_snapshot_check
  CHECK (app.is_actor_identity_snapshot(deleted_by_snapshot, deleted_by));
ALTER TABLE app.features
  ADD CONSTRAINT features_created_by_snapshot_check
  CHECK (app.is_actor_identity_snapshot(created_by_snapshot, created_by)),
  ADD CONSTRAINT features_deleted_by_snapshot_check
  CHECK (app.is_actor_identity_snapshot(deleted_by_snapshot, deleted_by));
ALTER TABLE app.tasks
  ADD CONSTRAINT tasks_creator_snapshot_check
  CHECK (app.is_actor_identity_snapshot(creator_snapshot, creator_id)),
  ADD CONSTRAINT tasks_deleted_by_snapshot_check
  CHECK (app.is_actor_identity_snapshot(deleted_by_snapshot, deleted_by));
ALTER TABLE app.task_assignees
  ADD CONSTRAINT task_assignees_user_snapshot_check
  CHECK (app.is_actor_identity_snapshot(user_snapshot, user_id));
ALTER TABLE app.task_status_history
  ADD CONSTRAINT task_status_history_changed_by_snapshot_check
  CHECK (app.is_actor_identity_snapshot(changed_by_snapshot, changed_by));
ALTER TABLE app.task_groups
  ADD CONSTRAINT task_groups_created_by_snapshot_check
  CHECK (app.is_actor_identity_snapshot(created_by_snapshot, created_by));
ALTER TABLE app.task_group_members
  ADD CONSTRAINT task_group_members_original_assignee_snapshot_check
  CHECK (app.is_actor_identity_snapshot(original_assignee_snapshot, original_assignee_id)),
  ADD CONSTRAINT task_group_members_detached_by_snapshot_check
  CHECK (app.is_actor_identity_snapshot(detached_by_snapshot, detached_by));
ALTER TABLE app.change_records
  ADD CONSTRAINT change_records_handler_snapshot_check
  CHECK (app.is_actor_identity_snapshot(handler_snapshot, handler_id)),
  ADD CONSTRAINT change_records_author_snapshot_check
  CHECK (app.is_actor_identity_snapshot(author_snapshot, author_id));
ALTER TABLE app.change_record_versions
  ADD CONSTRAINT change_record_versions_created_by_snapshot_check
  CHECK (app.is_actor_identity_snapshot(created_by_snapshot, created_by));
ALTER TABLE app.change_record_leftover_items
  ADD CONSTRAINT change_record_leftover_items_created_by_snapshot_check
  CHECK (app.is_actor_identity_snapshot(created_by_snapshot, created_by));
ALTER TABLE app.leftover_task_links
  ADD CONSTRAINT leftover_task_links_created_by_snapshot_check
  CHECK (app.is_actor_identity_snapshot(created_by_snapshot, created_by));
ALTER TABLE app.external_links
  ADD CONSTRAINT external_links_created_by_snapshot_check
  CHECK (app.is_actor_identity_snapshot(created_by_snapshot, created_by));
ALTER TABLE app.document_import_runs
  ADD CONSTRAINT document_import_runs_actor_snapshot_check
  CHECK (app.is_actor_identity_snapshot(actor_snapshot, actor_id));
ALTER TABLE app.ai_assist_settings
  ADD CONSTRAINT ai_assist_settings_updated_by_snapshot_check
  CHECK (app.is_actor_identity_snapshot(updated_by_snapshot, updated_by));
ALTER TABLE app.wecom_robot_config
  ADD CONSTRAINT wecom_robot_config_updated_by_snapshot_check
  CHECK (app.is_actor_identity_snapshot(updated_by_snapshot, updated_by));
ALTER TABLE app.project_wecom_binding_codes
  ADD CONSTRAINT project_wecom_binding_codes_consumer_snapshot_check
  CHECK (app.is_actor_identity_snapshot(consumed_by_user_snapshot, consumed_by_user_id));
ALTER TABLE app.project_wecom_groups
  ADD CONSTRAINT project_wecom_groups_bound_by_snapshot_check
  CHECK (app.is_actor_identity_snapshot(bound_by_snapshot, bound_by_user_id));
ALTER TABLE app.project_archive_requests
  ADD CONSTRAINT project_archive_requests_requested_by_snapshot_check
  CHECK (app.is_actor_identity_snapshot(requested_by_snapshot, requested_by)),
  ADD CONSTRAINT project_archive_requests_decided_by_snapshot_check
  CHECK (app.is_actor_identity_snapshot(decided_by_snapshot, decided_by));

CREATE TRIGGER projects_capture_created_by_snapshot
BEFORE INSERT OR UPDATE OF created_by ON app.projects
FOR EACH ROW EXECUTE FUNCTION app.capture_actor_identity_snapshot('created_by', 'created_by_snapshot');
CREATE TRIGGER project_members_capture_user_snapshot
BEFORE INSERT OR UPDATE OF user_id ON app.project_members
FOR EACH ROW EXECUTE FUNCTION app.capture_actor_identity_snapshot('user_id', 'user_snapshot');
CREATE TRIGGER modules_capture_created_by_snapshot
BEFORE INSERT OR UPDATE OF created_by ON app.modules
FOR EACH ROW EXECUTE FUNCTION app.capture_actor_identity_snapshot('created_by', 'created_by_snapshot');
CREATE TRIGGER modules_capture_deleted_by_snapshot
BEFORE INSERT OR UPDATE OF deleted_by ON app.modules
FOR EACH ROW EXECUTE FUNCTION app.capture_actor_identity_snapshot('deleted_by', 'deleted_by_snapshot');
CREATE TRIGGER features_capture_created_by_snapshot
BEFORE INSERT OR UPDATE OF created_by ON app.features
FOR EACH ROW EXECUTE FUNCTION app.capture_actor_identity_snapshot('created_by', 'created_by_snapshot');
CREATE TRIGGER features_capture_deleted_by_snapshot
BEFORE INSERT OR UPDATE OF deleted_by ON app.features
FOR EACH ROW EXECUTE FUNCTION app.capture_actor_identity_snapshot('deleted_by', 'deleted_by_snapshot');
CREATE TRIGGER tasks_capture_creator_snapshot
BEFORE INSERT OR UPDATE OF creator_id ON app.tasks
FOR EACH ROW EXECUTE FUNCTION app.capture_actor_identity_snapshot('creator_id', 'creator_snapshot');
CREATE TRIGGER tasks_capture_deleted_by_snapshot
BEFORE INSERT OR UPDATE OF deleted_by ON app.tasks
FOR EACH ROW EXECUTE FUNCTION app.capture_actor_identity_snapshot('deleted_by', 'deleted_by_snapshot');
CREATE TRIGGER task_assignees_capture_user_snapshot
BEFORE INSERT OR UPDATE OF user_id ON app.task_assignees
FOR EACH ROW EXECUTE FUNCTION app.capture_actor_identity_snapshot('user_id', 'user_snapshot');
CREATE TRIGGER task_status_history_capture_changed_by_snapshot
BEFORE INSERT OR UPDATE OF changed_by ON app.task_status_history
FOR EACH ROW EXECUTE FUNCTION app.capture_actor_identity_snapshot('changed_by', 'changed_by_snapshot');
CREATE TRIGGER task_groups_capture_created_by_snapshot
BEFORE INSERT OR UPDATE OF created_by ON app.task_groups
FOR EACH ROW EXECUTE FUNCTION app.capture_actor_identity_snapshot('created_by', 'created_by_snapshot');
CREATE TRIGGER task_group_members_capture_original_assignee_snapshot
BEFORE INSERT OR UPDATE OF original_assignee_id ON app.task_group_members
FOR EACH ROW EXECUTE FUNCTION app.capture_actor_identity_snapshot('original_assignee_id', 'original_assignee_snapshot');
CREATE TRIGGER task_group_members_capture_detached_by_snapshot
BEFORE INSERT OR UPDATE OF detached_by ON app.task_group_members
FOR EACH ROW EXECUTE FUNCTION app.capture_actor_identity_snapshot('detached_by', 'detached_by_snapshot');
CREATE TRIGGER change_records_capture_handler_snapshot
BEFORE INSERT OR UPDATE OF handler_id ON app.change_records
FOR EACH ROW EXECUTE FUNCTION app.capture_actor_identity_snapshot('handler_id', 'handler_snapshot');
CREATE TRIGGER change_records_capture_author_snapshot
BEFORE INSERT OR UPDATE OF author_id ON app.change_records
FOR EACH ROW EXECUTE FUNCTION app.capture_actor_identity_snapshot('author_id', 'author_snapshot');
CREATE TRIGGER change_record_versions_capture_created_by_snapshot
BEFORE INSERT OR UPDATE OF created_by ON app.change_record_versions
FOR EACH ROW EXECUTE FUNCTION app.capture_actor_identity_snapshot('created_by', 'created_by_snapshot');
CREATE TRIGGER change_record_leftover_items_capture_created_by_snapshot
BEFORE INSERT OR UPDATE OF created_by ON app.change_record_leftover_items
FOR EACH ROW EXECUTE FUNCTION app.capture_actor_identity_snapshot('created_by', 'created_by_snapshot');
CREATE TRIGGER leftover_task_links_capture_created_by_snapshot
BEFORE INSERT OR UPDATE OF created_by ON app.leftover_task_links
FOR EACH ROW EXECUTE FUNCTION app.capture_actor_identity_snapshot('created_by', 'created_by_snapshot');
CREATE TRIGGER external_links_capture_created_by_snapshot
BEFORE INSERT OR UPDATE OF created_by ON app.external_links
FOR EACH ROW EXECUTE FUNCTION app.capture_actor_identity_snapshot('created_by', 'created_by_snapshot');
CREATE TRIGGER document_import_runs_capture_actor_snapshot
BEFORE INSERT OR UPDATE OF actor_id ON app.document_import_runs
FOR EACH ROW EXECUTE FUNCTION app.capture_actor_identity_snapshot('actor_id', 'actor_snapshot');
CREATE TRIGGER ai_assist_settings_capture_updated_by_snapshot
BEFORE INSERT OR UPDATE OF updated_by ON app.ai_assist_settings
FOR EACH ROW EXECUTE FUNCTION app.capture_actor_identity_snapshot('updated_by', 'updated_by_snapshot');
CREATE TRIGGER wecom_robot_config_capture_updated_by_snapshot
BEFORE INSERT OR UPDATE OF updated_by ON app.wecom_robot_config
FOR EACH ROW EXECUTE FUNCTION app.capture_actor_identity_snapshot('updated_by', 'updated_by_snapshot');
CREATE TRIGGER project_wecom_binding_codes_capture_consumed_by_snapshot
BEFORE INSERT OR UPDATE OF consumed_by_user_id ON app.project_wecom_binding_codes
FOR EACH ROW EXECUTE FUNCTION app.capture_actor_identity_snapshot('consumed_by_user_id', 'consumed_by_user_snapshot');
CREATE TRIGGER project_wecom_groups_capture_bound_by_snapshot
BEFORE INSERT OR UPDATE OF bound_by_user_id ON app.project_wecom_groups
FOR EACH ROW EXECUTE FUNCTION app.capture_actor_identity_snapshot('bound_by_user_id', 'bound_by_snapshot');
CREATE TRIGGER project_archive_requests_capture_requested_by_snapshot
BEFORE INSERT OR UPDATE OF requested_by ON app.project_archive_requests
FOR EACH ROW EXECUTE FUNCTION app.capture_actor_identity_snapshot('requested_by', 'requested_by_snapshot');
CREATE TRIGGER project_archive_requests_capture_decided_by_snapshot
BEFORE INSERT OR UPDATE OF decided_by ON app.project_archive_requests
FOR EACH ROW EXECUTE FUNCTION app.capture_actor_identity_snapshot('decided_by', 'decided_by_snapshot');

DO $$
DECLARE
  snapshot_constraints INTEGER;
  snapshot_triggers INTEGER;
BEGIN
  SELECT count(*)::INTEGER
    INTO snapshot_constraints
    FROM pg_constraint
   WHERE conname IN (
     'projects_created_by_snapshot_check',
     'project_members_user_snapshot_check',
     'modules_created_by_snapshot_check',
     'modules_deleted_by_snapshot_check',
     'features_created_by_snapshot_check',
     'features_deleted_by_snapshot_check',
     'tasks_creator_snapshot_check',
     'tasks_deleted_by_snapshot_check',
     'task_assignees_user_snapshot_check',
     'task_status_history_changed_by_snapshot_check',
     'task_groups_created_by_snapshot_check',
     'task_group_members_original_assignee_snapshot_check',
     'task_group_members_detached_by_snapshot_check',
     'change_records_handler_snapshot_check',
     'change_records_author_snapshot_check',
     'change_record_versions_created_by_snapshot_check',
     'change_record_leftover_items_created_by_snapshot_check',
     'leftover_task_links_created_by_snapshot_check',
     'external_links_created_by_snapshot_check',
     'document_import_runs_actor_snapshot_check',
     'ai_assist_settings_updated_by_snapshot_check',
     'wecom_robot_config_updated_by_snapshot_check',
     'project_wecom_binding_codes_consumer_snapshot_check',
     'project_wecom_groups_bound_by_snapshot_check',
     'project_archive_requests_requested_by_snapshot_check',
     'project_archive_requests_decided_by_snapshot_check'
   )
     AND convalidated;

  SELECT count(*)::INTEGER
    INTO snapshot_triggers
    FROM pg_trigger
   WHERE NOT tgisinternal
     AND tgname LIKE '%_capture_%_snapshot'
     AND tgenabled = 'O';

  IF snapshot_constraints <> 26 OR snapshot_triggers <> 26 THEN
    RAISE EXCEPTION
      'actor snapshot constraints/triggers mismatch: constraints=%, triggers=%',
      snapshot_constraints,
      snapshot_triggers;
  END IF;
END
$$;
