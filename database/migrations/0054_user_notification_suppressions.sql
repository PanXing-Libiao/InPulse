-- 服务端个人通知偏好：关闭的类型在写入前抑制，查询时也隐藏历史记录。
--
-- 口径（2026-10-20 用户要求「开关要和实际发送信息关联起来」）：
--   1. 每个用户、每个实际站内通知类型一行；行存在表示该类型被关闭，缺省为开启；
--   2. setting_key 保留设置页的开关键，便于读取时还原开关状态；
--   3. 关闭只停止新通知写入，并让同类型历史通知在列表/未读数中隐藏，不物理删除历史；
--   4. 用户物理删除时级联清理偏好（偏好不是业务历史）。
--
-- app_runtime 只用 SELECT / INSERT / DELETE（整组替换 = 先删后插），不需要 UPDATE。

SET LOCAL ROLE app_owner;

CREATE TABLE app.user_notification_suppressions (
  user_id INTEGER NOT NULL,
  notification_type TEXT NOT NULL,
  setting_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT user_notification_suppressions_pkey
    PRIMARY KEY (user_id, notification_type),
  CONSTRAINT user_notification_suppressions_user_fk
    FOREIGN KEY (user_id) REFERENCES app.users(id)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT user_notification_suppressions_type_check
    CHECK (notification_type ~ '^[A-Za-z][A-Za-z0-9._-]{0,99}$'),
  CONSTRAINT user_notification_suppressions_setting_check
    CHECK (setting_key = ANY (ARRAY[
      'PROJECT_JOINED',
      'task.assigned',
      'task.complete',
      'task.reopen',
      'task.merge',
      'task.unmerge',
      'record.publish',
      'record.version.create',
      'record.leftover.add',
      'leftover.convert',
      'project.status.change'
    ]::TEXT[]))
);

CREATE INDEX user_notification_suppressions_setting_idx
  ON app.user_notification_suppressions (user_id, setting_key);

COMMENT ON TABLE app.user_notification_suppressions IS
  '个人通知抑制项：行存在即关闭该实际通知类型；写入端口与通知查询共用。';

REVOKE ALL ON app.user_notification_suppressions FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON app.user_notification_suppressions TO app_runtime;
GRANT SELECT ON app.user_notification_suppressions TO app_backup;

-- 部署校验：表归属、主键、级联外键、检查约束与授权口径必须同时成立。
DO $$
DECLARE
  table_owner TEXT;
  primary_key_count INTEGER;
  fk_delete_action TEXT;
  type_check_count INTEGER;
  setting_check_count INTEGER;
BEGIN
  SELECT pg_get_userbyid(c.relowner)
    INTO table_owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app'
     AND c.relname = 'user_notification_suppressions'
     AND c.relkind = 'r';

  IF table_owner IS DISTINCT FROM 'app_owner' THEN
    RAISE EXCEPTION
      'app.user_notification_suppressions must be owned by app_owner, got %',
      table_owner;
  END IF;

  SELECT count(*)
    INTO primary_key_count
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'app'
     AND t.relname = 'user_notification_suppressions'
     AND c.conname = 'user_notification_suppressions_pkey'
     AND c.contype = 'p';

  IF primary_key_count <> 1 THEN
    RAISE EXCEPTION 'user_notification_suppressions_pkey is missing';
  END IF;

  SELECT confdeltype
    INTO fk_delete_action
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'app'
     AND t.relname = 'user_notification_suppressions'
     AND c.conname = 'user_notification_suppressions_user_fk';

  IF fk_delete_action IS DISTINCT FROM 'c' THEN
    RAISE EXCEPTION
      'user_notification_suppressions_user_fk must be ON DELETE CASCADE, got %',
      fk_delete_action;
  END IF;

  SELECT count(*)
    INTO type_check_count
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'app'
     AND t.relname = 'user_notification_suppressions'
     AND c.conname = 'user_notification_suppressions_type_check'
     AND c.contype = 'c';

  IF type_check_count <> 1 THEN
    RAISE EXCEPTION 'user_notification_suppressions_type_check is missing';
  END IF;

  SELECT count(*)
    INTO setting_check_count
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'app'
     AND t.relname = 'user_notification_suppressions'
     AND c.conname = 'user_notification_suppressions_setting_check'
     AND c.contype = 'c';

  IF setting_check_count <> 1 THEN
    RAISE EXCEPTION 'user_notification_suppressions_setting_check is missing';
  END IF;

  IF NOT (
    has_table_privilege('app_runtime', 'app.user_notification_suppressions', 'SELECT')
    AND has_table_privilege('app_runtime', 'app.user_notification_suppressions', 'INSERT')
    AND has_table_privilege('app_runtime', 'app.user_notification_suppressions', 'DELETE')
  ) THEN
    RAISE EXCEPTION
      'app_runtime must have SELECT / INSERT / DELETE on app.user_notification_suppressions';
  END IF;

  IF NOT has_table_privilege('app_backup', 'app.user_notification_suppressions', 'SELECT')
     OR has_table_privilege('app_backup', 'app.user_notification_suppressions', 'INSERT')
     OR has_table_privilege('app_backup', 'app.user_notification_suppressions', 'DELETE') THEN
    RAISE EXCEPTION
      'app_backup must have read-only access to app.user_notification_suppressions';
  END IF;
END
$$;
