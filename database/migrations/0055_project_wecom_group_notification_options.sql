SET LOCAL ROLE app_owner;

-- ADR-090：企业微信项目群通知选项（项目级、服务端持久化）。
-- 口径：
--   1. 一个项目至多一行；没有行时按“全部开启”解释，首次保存才落行；
--   2. 五个开关与契约 projectNotificationCategories 一一对应，桥接物化
--      app.wecom_group_deliveries 前读取本表；关闭只影响之后物化的群消息，
--      不删除已排队/已发送的历史；
--   3. app_runtime 只有 SELECT / INSERT / UPDATE；app_backup 只读；
--   4. 项目物理删除由 app.projects 的 ON DELETE CASCADE 清理本表。
CREATE TABLE app.project_wecom_group_notification_options (
  project_id INTEGER PRIMARY KEY,
  task_assign_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  task_status_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  record_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  project_member_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  scope_delete_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT project_wecom_group_notification_options_row_version_check
    CHECK (row_version >= 1),
  CONSTRAINT project_wecom_group_notification_options_project_fk
    FOREIGN KEY (project_id) REFERENCES app.projects(id)
    ON DELETE CASCADE ON UPDATE NO ACTION
);

COMMENT ON TABLE app.project_wecom_group_notification_options IS
  'ADR-090 项目企微群通知开关；缺行表示五类全部开启。';

GRANT SELECT, INSERT, UPDATE ON app.project_wecom_group_notification_options TO app_runtime;
GRANT SELECT ON app.project_wecom_group_notification_options TO app_backup;

DO $$
DECLARE
  table_owner TEXT;
  project_fk_action "char";
  runtime_ok BOOLEAN;
  backup_ok BOOLEAN;
BEGIN
  SELECT pg_get_userbyid(c.relowner)
    INTO table_owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app'
     AND c.relname = 'project_wecom_group_notification_options'
     AND c.relkind = 'r';

  IF table_owner IS NULL OR table_owner <> 'app_owner' THEN
    RAISE EXCEPTION
      'app.project_wecom_group_notification_options must be owned by app_owner';
  END IF;

  SELECT c.confdeltype
    INTO project_fk_action
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'app'
     AND t.relname = 'project_wecom_group_notification_options'
     AND c.conname = 'project_wecom_group_notification_options_project_fk'
     AND c.contype = 'f';

  IF project_fk_action IS DISTINCT FROM 'c' THEN
    RAISE EXCEPTION
      'project_wecom_group_notification_options_project_fk must cascade';
  END IF;

  SELECT
    has_table_privilege('app_runtime', 'app.project_wecom_group_notification_options', 'SELECT')
    AND has_table_privilege('app_runtime', 'app.project_wecom_group_notification_options', 'INSERT')
    AND has_table_privilege('app_runtime', 'app.project_wecom_group_notification_options', 'UPDATE')
    AND NOT has_table_privilege('app_runtime', 'app.project_wecom_group_notification_options', 'DELETE')
    INTO runtime_ok;
  IF NOT runtime_ok THEN
    RAISE EXCEPTION
      'app_runtime must have SELECT / INSERT / UPDATE and no DELETE on project wecom group notification options';
  END IF;

  SELECT
    has_table_privilege('app_backup', 'app.project_wecom_group_notification_options', 'SELECT')
    AND NOT has_table_privilege('app_backup', 'app.project_wecom_group_notification_options', 'INSERT')
    AND NOT has_table_privilege('app_backup', 'app.project_wecom_group_notification_options', 'UPDATE')
    AND NOT has_table_privilege('app_backup', 'app.project_wecom_group_notification_options', 'DELETE')
    INTO backup_ok;
  IF NOT backup_ok THEN
    RAISE EXCEPTION
      'app_backup must have read-only access to project wecom group notification options';
  END IF;
END
$$;
