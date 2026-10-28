SET LOCAL ROLE app_owner;

-- ADR-104：全平台统一的项目成员能力三档配置（单行、管理员保存）。
-- 口径：
--   1. 配置全平台共享，不按项目拆分；每项只能取 ALL_MEMBERS / LEADERS_ONLY /
--      ADMINS_ONLY，未知值由 CHECK 拒绝；
--   2. 查看项目与动态、创建项目、个人通知与企业微信固定开放，不进入本表；
--      迭代记录作废/恢复与系统管理固定仅管理员，同样不进入本表；
--   3. 默认值与引入配置前的既有行为逐项一致，升级时不放大或收回任何权限；
--   4. 单行表预插 id = 1；应用只读、更新，配置永不删除；
--   5. 最近保存人使用 ADR-088 身份快照，避免物理删除用户后丢失展示来源。

CREATE TABLE app.project_member_permission_settings (
  id SMALLINT PRIMARY KEY,
  project_edit TEXT NOT NULL,
  project_member_manage TEXT NOT NULL,
  project_leader_transfer TEXT NOT NULL,
  project_delete TEXT NOT NULL,
  project_document_import TEXT NOT NULL,
  module_feature_edit TEXT NOT NULL,
  module_feature_delete TEXT NOT NULL,
  task_edit TEXT NOT NULL,
  task_lifecycle TEXT NOT NULL,
  record_write TEXT NOT NULL,
  project_wecom_group TEXT NOT NULL,
  updated_by INTEGER NULL,
  updated_by_snapshot JSONB NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT project_member_permission_settings_singleton_check
    CHECK (id = 1),
  CONSTRAINT project_member_permission_settings_project_edit_check
    CHECK (project_edit IN ('ALL_MEMBERS', 'LEADERS_ONLY', 'ADMINS_ONLY')),
  CONSTRAINT project_member_permission_settings_project_member_manage_check
    CHECK (project_member_manage IN ('ALL_MEMBERS', 'LEADERS_ONLY', 'ADMINS_ONLY')),
  CONSTRAINT project_member_permission_settings_leader_transfer_check
    CHECK (project_leader_transfer IN ('ALL_MEMBERS', 'LEADERS_ONLY', 'ADMINS_ONLY')),
  CONSTRAINT project_member_permission_settings_project_delete_check
    CHECK (project_delete IN ('ALL_MEMBERS', 'LEADERS_ONLY', 'ADMINS_ONLY')),
  CONSTRAINT project_member_permission_settings_document_import_check
    CHECK (project_document_import IN ('ALL_MEMBERS', 'LEADERS_ONLY', 'ADMINS_ONLY')),
  CONSTRAINT project_member_permission_settings_module_feature_edit_check
    CHECK (module_feature_edit IN ('ALL_MEMBERS', 'LEADERS_ONLY', 'ADMINS_ONLY')),
  CONSTRAINT project_member_permission_settings_module_feature_delete_check
    CHECK (module_feature_delete IN ('ALL_MEMBERS', 'LEADERS_ONLY', 'ADMINS_ONLY')),
  CONSTRAINT project_member_permission_settings_task_edit_check
    CHECK (task_edit IN ('ALL_MEMBERS', 'LEADERS_ONLY', 'ADMINS_ONLY')),
  CONSTRAINT project_member_permission_settings_task_lifecycle_check
    CHECK (task_lifecycle IN ('ALL_MEMBERS', 'LEADERS_ONLY', 'ADMINS_ONLY')),
  CONSTRAINT project_member_permission_settings_record_write_check
    CHECK (record_write IN ('ALL_MEMBERS', 'LEADERS_ONLY', 'ADMINS_ONLY')),
  CONSTRAINT project_member_permission_settings_project_wecom_group_check
    CHECK (project_wecom_group IN ('ALL_MEMBERS', 'LEADERS_ONLY', 'ADMINS_ONLY')),
  CONSTRAINT project_member_permission_settings_row_version_check
    CHECK (row_version >= 1),
  CONSTRAINT project_member_permission_settings_updated_by_snapshot_check
    CHECK (app.is_actor_identity_snapshot(updated_by_snapshot, updated_by))
);

COMMENT ON TABLE app.project_member_permission_settings IS
  'ADR-104 全平台项目成员能力三档配置；单行 id=1，默认值保持既有行为。';

INSERT INTO app.project_member_permission_settings (
  id,
  project_edit,
  project_member_manage,
  project_leader_transfer,
  project_delete,
  project_document_import,
  module_feature_edit,
  module_feature_delete,
  task_edit,
  task_lifecycle,
  record_write,
  project_wecom_group,
  updated_by,
  updated_by_snapshot,
  updated_at,
  row_version
) VALUES (
  1,
  'ALL_MEMBERS',
  'ALL_MEMBERS',
  'LEADERS_ONLY',
  'LEADERS_ONLY',
  'ALL_MEMBERS',
  'ALL_MEMBERS',
  'LEADERS_ONLY',
  'ALL_MEMBERS',
  'ALL_MEMBERS',
  'ALL_MEMBERS',
  'LEADERS_ONLY',
  NULL,
  NULL,
  now(),
  1
);

CREATE TRIGGER project_member_permission_settings_capture_updated_by
BEFORE INSERT OR UPDATE OF updated_by ON app.project_member_permission_settings
FOR EACH ROW EXECUTE FUNCTION app.capture_actor_identity_snapshot(
  'updated_by',
  'updated_by_snapshot'
);

GRANT SELECT, UPDATE ON app.project_member_permission_settings TO app_runtime;
GRANT SELECT ON app.project_member_permission_settings TO app_backup;

DO $$
DECLARE
  table_owner TEXT;
  row_count INTEGER;
  constraint_count INTEGER;
  trigger_count INTEGER;
  runtime_ok BOOLEAN;
  backup_ok BOOLEAN;
  defaults_ok BOOLEAN;
BEGIN
  SELECT pg_get_userbyid(c.relowner)
    INTO table_owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app'
     AND c.relname = 'project_member_permission_settings'
     AND c.relkind = 'r';
  IF table_owner IS DISTINCT FROM 'app_owner' THEN
    RAISE EXCEPTION
      'app.project_member_permission_settings must be owned by app_owner';
  END IF;

  SELECT count(*)::INTEGER
    INTO row_count
    FROM app.project_member_permission_settings;
  IF row_count <> 1 THEN
    RAISE EXCEPTION
      'app.project_member_permission_settings must contain exactly one row, found %',
      row_count;
  END IF;

  SELECT count(*)::INTEGER
    INTO constraint_count
    FROM pg_constraint
   WHERE conrelid = 'app.project_member_permission_settings'::regclass
     AND conname LIKE 'project_member_permission_settings_%_check';
  IF constraint_count <> 14 THEN
    RAISE EXCEPTION
      'project member permission constraints are incomplete: %',
      constraint_count;
  END IF;

  SELECT count(*)::INTEGER
    INTO trigger_count
    FROM pg_trigger
   WHERE tgrelid = 'app.project_member_permission_settings'::regclass
     AND tgname = 'project_member_permission_settings_capture_updated_by'
     AND NOT tgisinternal
     AND tgenabled = 'O';
  IF trigger_count <> 1 THEN
    RAISE EXCEPTION
      'project_member_permission_settings_capture_updated_by is missing';
  END IF;

  SELECT
    has_table_privilege('app_runtime', 'app.project_member_permission_settings', 'SELECT')
    AND has_table_privilege('app_runtime', 'app.project_member_permission_settings', 'UPDATE')
    AND NOT has_table_privilege('app_runtime', 'app.project_member_permission_settings', 'INSERT')
    AND NOT has_table_privilege('app_runtime', 'app.project_member_permission_settings', 'DELETE')
    INTO runtime_ok;
  IF NOT runtime_ok THEN
    RAISE EXCEPTION
      'app_runtime must have SELECT / UPDATE and no INSERT / DELETE on project member permission settings';
  END IF;

  SELECT
    has_table_privilege('app_backup', 'app.project_member_permission_settings', 'SELECT')
    AND NOT has_table_privilege('app_backup', 'app.project_member_permission_settings', 'INSERT')
    AND NOT has_table_privilege('app_backup', 'app.project_member_permission_settings', 'UPDATE')
    AND NOT has_table_privilege('app_backup', 'app.project_member_permission_settings', 'DELETE')
    INTO backup_ok;
  IF NOT backup_ok THEN
    RAISE EXCEPTION
      'app_backup must have read-only access to project member permission settings';
  END IF;

  SELECT
    project_edit = 'ALL_MEMBERS'
    AND project_member_manage = 'ALL_MEMBERS'
    AND project_leader_transfer = 'LEADERS_ONLY'
    AND project_delete = 'LEADERS_ONLY'
    AND project_document_import = 'ALL_MEMBERS'
    AND module_feature_edit = 'ALL_MEMBERS'
    AND module_feature_delete = 'LEADERS_ONLY'
    AND task_edit = 'ALL_MEMBERS'
    AND task_lifecycle = 'ALL_MEMBERS'
    AND record_write = 'ALL_MEMBERS'
    AND project_wecom_group = 'LEADERS_ONLY'
    AND row_version = 1
    INTO defaults_ok
    FROM app.project_member_permission_settings
   WHERE id = 1;
  IF NOT COALESCE(defaults_ok, false) THEN
    RAISE EXCEPTION
      'project member permission default row does not match ADR-104';
  END IF;
END
$$;
