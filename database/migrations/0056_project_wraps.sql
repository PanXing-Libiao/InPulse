-- ADR-091：项目封箱（项目第一次进入维护中且已有完成任务时发生一次）。
-- 快照冻结封箱当时可见的项目统计与时间线；桥接用这份数据渲染海报。
-- project_wraps 只允许 INSERT，不允许 UPDATE/DELETE，业务历史不随成员或任务后续变化。

SET LOCAL ROLE app_owner;

CREATE TABLE app.project_wraps (
  project_id INTEGER PRIMARY KEY,
  sealed_at TIMESTAMPTZ NOT NULL,
  sealed_by INTEGER NOT NULL,
  sealed_by_snapshot JSONB NOT NULL,
  template_version INTEGER NOT NULL DEFAULT 1,
  snapshot JSONB NOT NULL,
  CONSTRAINT project_wraps_project_fk
    FOREIGN KEY (project_id) REFERENCES app.projects(id)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT project_wraps_sealed_by_check
    CHECK (sealed_by > 0),
  CONSTRAINT project_wraps_template_version_check
    CHECK (template_version >= 1),
  CONSTRAINT project_wraps_sealed_by_snapshot_check
    CHECK (
      jsonb_typeof(sealed_by_snapshot) = 'object'
      AND jsonb_typeof(sealed_by_snapshot->'id') = 'number'
      AND jsonb_typeof(sealed_by_snapshot->'name') = 'string'
      AND length(btrim(sealed_by_snapshot->>'name')) BETWEEN 1 AND 200
      AND sealed_by_snapshot->>'id' = sealed_by::text
    ),
  CONSTRAINT project_wraps_snapshot_check
    CHECK (
      jsonb_typeof(snapshot) = 'object'
      AND snapshot->>'version' = template_version::text
      AND jsonb_typeof(snapshot->'project') = 'object'
      AND jsonb_typeof(snapshot->'stats') = 'object'
      AND jsonb_typeof(snapshot->'participants') = 'array'
      AND jsonb_typeof(snapshot->'timeline') = 'object'
      AND pg_column_size(snapshot) <= 262144
    )
);

COMMENT ON TABLE app.project_wraps IS
  'ADR-091 项目封箱快照：每个项目终生至多一行，只增不改；项目物理删除时级联清理。';

-- 项目群“文字 + 海报”是两段发送；记录已成功的段数，避免图片失败或进程重启后
-- 把已送达的文字再发一遍。普通单段群消息成功后仍会直接标 SENT。
ALTER TABLE app.wecom_group_deliveries
  ADD COLUMN delivered_step_count INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT wecom_group_deliveries_delivered_step_count_check
    CHECK (delivered_step_count >= 0);

COMMENT ON COLUMN app.wecom_group_deliveries.delivered_step_count IS
  'ADR-091 已成功发送的消息段数；项目封箱为文字、海报两段，其余消息为一段。';
COMMENT ON COLUMN app.project_wraps.sealed_by IS
  '封箱操作人用户 ID；不设外键，用户物理删除后仍保留历史 ID 与 sealed_by_snapshot。';

REVOKE ALL ON app.project_wraps FROM PUBLIC;
GRANT SELECT, INSERT ON app.project_wraps TO app_runtime;
GRANT SELECT ON app.project_wraps TO app_backup;

-- 个人通知偏好沿用 project.status.change 开关键；已关闭该开关的用户，
-- 升级后也必须同时抑制新的 project.wrapped 通知，重新开启时会整组替换。
INSERT INTO app.user_notification_suppressions (
  user_id,
  notification_type,
  setting_key
)
SELECT user_id,
       'project.wrapped',
       setting_key
  FROM app.user_notification_suppressions
 WHERE setting_key = 'project.status.change'
ON CONFLICT (user_id, notification_type) DO NOTHING;

DO $$
DECLARE
  table_owner TEXT;
  fk_delete_action TEXT;
  runtime_ok BOOLEAN;
  backup_ok BOOLEAN;
  snapshot_check_count INTEGER;
BEGIN
  SELECT pg_get_userbyid(c.relowner)
    INTO table_owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app'
     AND c.relname = 'project_wraps'
     AND c.relkind = 'r';

  IF table_owner IS DISTINCT FROM 'app_owner' THEN
    RAISE EXCEPTION
      'app.project_wraps must be owned by app_owner, got %',
      table_owner;
  END IF;

  SELECT confdeltype
    INTO fk_delete_action
    FROM pg_constraint
   WHERE conrelid = 'app.project_wraps'::regclass
     AND conname = 'project_wraps_project_fk'
     AND contype = 'f';

  IF fk_delete_action IS DISTINCT FROM 'c' THEN
    RAISE EXCEPTION
      'project_wraps_project_fk must be ON DELETE CASCADE';
  END IF;

  SELECT count(*)::INTEGER
    INTO snapshot_check_count
    FROM pg_constraint
   WHERE conrelid = 'app.project_wraps'::regclass
     AND conname = 'project_wraps_snapshot_check'
     AND contype = 'c';
  IF snapshot_check_count <> 1 THEN
    RAISE EXCEPTION 'project_wraps_snapshot_check is missing';
  END IF;

  SELECT
    has_table_privilege('app_runtime', 'app.project_wraps', 'SELECT')
    AND has_table_privilege('app_runtime', 'app.project_wraps', 'INSERT')
    AND NOT has_table_privilege('app_runtime', 'app.project_wraps', 'UPDATE')
    AND NOT has_table_privilege('app_runtime', 'app.project_wraps', 'DELETE')
    INTO runtime_ok;
  IF NOT runtime_ok THEN
    RAISE EXCEPTION
      'app_runtime must have SELECT / INSERT and no UPDATE / DELETE on app.project_wraps';
  END IF;

  SELECT
    has_table_privilege('app_backup', 'app.project_wraps', 'SELECT')
    AND NOT has_table_privilege('app_backup', 'app.project_wraps', 'INSERT')
    AND NOT has_table_privilege('app_backup', 'app.project_wraps', 'UPDATE')
    AND NOT has_table_privilege('app_backup', 'app.project_wraps', 'DELETE')
    INTO backup_ok;
  IF NOT backup_ok THEN
    RAISE EXCEPTION
      'app_backup must have read-only access to app.project_wraps';
  END IF;
END
$$;
