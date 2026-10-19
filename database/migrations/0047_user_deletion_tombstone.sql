SET LOCAL ROLE app_owner;

-- ADR-082：离职用户强制删除采用不可逆墓碑化，不物理删除 app.users。
-- 口径：
--   1. 只允许删除已 DISABLED 且没有任何 ACTIVE 项目成员关系的账号；
--      组长必须先转移、成员必须先退出项目，避免历史归属失去负责人。
--   2. 删除时保留用户主键以满足审计、项目创建人、任务负责人等历史外键，
--      但清除登录名、姓名、邮箱、头像、组织、口令与管理员身份；
--      原登录名释放给后续员工复用，墓碑登录名固定为 deleted-user-{id}。
--   3. deleted_at 一经写入不可清除；墓碑账号不可再次更新、启用或登录。
--      SSO subject 保留用于阻止同一统一身份静默接管新账号，重新入职需另立 ADR。
--   4. 历史业务表通过 JOIN app.users 展示姓名时会自动显示“删除用户”；
--      审计原始事件载荷与哈希链保持不可变，界面可另行显示当前墓碑名。

ALTER TABLE app.users
  ADD COLUMN deleted_at TIMESTAMPTZ;

ALTER TABLE app.users
  ADD CONSTRAINT users_deleted_state_check
    CHECK (
      deleted_at IS NULL
      OR (
        status = 'DISABLED'
        AND disabled_at IS NOT NULL
        AND login_name = 'deleted-user-' || id::text
        AND name = '删除用户'
        AND email IS NULL
        AND avatar_url IS NULL
        AND password_hash IS NULL
        AND organization_id IS NULL
        AND is_admin = false
      )
    );

CREATE FUNCTION app.enforce_users_immutable_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'users identity columns are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.deleted_at IS NOT NULL THEN
    IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
      RAISE EXCEPTION 'a deleted user is immutable'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.login_name IS DISTINCT FROM OLD.login_name
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    IF NEW.deleted_at IS NULL
       OR NEW.login_name IS DISTINCT FROM ('deleted-user-' || NEW.id::text)
       OR NEW.name IS DISTINCT FROM '删除用户'
       OR NEW.status IS DISTINCT FROM 'DISABLED'
       OR NEW.disabled_at IS NULL
       OR NEW.email IS NOT NULL
       OR NEW.avatar_url IS NOT NULL
       OR NEW.password_hash IS NOT NULL
       OR NEW.organization_id IS NOT NULL
       OR NEW.is_admin THEN
      RAISE EXCEPTION 'users may only be tombstoned once'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

DROP TRIGGER users_immutable_columns ON app.users;
CREATE TRIGGER users_immutable_columns
BEFORE UPDATE ON app.users
FOR EACH ROW EXECUTE FUNCTION app.enforce_users_immutable_columns();

-- 部署校验：列、约束、触发器函数与最终触发器必须同时成立。
DO $$
DECLARE
  deleted_column INTEGER;
  deleted_check INTEGER;
  deleted_check_validated BOOLEAN;
  tombstone_function INTEGER;
  trigger_definition TEXT;
BEGIN
  SELECT count(*)
    INTO deleted_column
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app'
     AND c.relname = 'users'
     AND a.attname = 'deleted_at'
     AND a.attnum > 0
     AND NOT a.attisdropped;

  IF deleted_column <> 1 THEN
    RAISE EXCEPTION 'app.users.deleted_at is missing';
  END IF;

  SELECT count(*), bool_and(c.convalidated)
    INTO deleted_check, deleted_check_validated
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'app'
     AND t.relname = 'users'
     AND c.conname = 'users_deleted_state_check'
     AND c.contype = 'c';

  IF deleted_check <> 1 OR NOT deleted_check_validated THEN
    RAISE EXCEPTION 'users_deleted_state_check is missing or not validated';
  END IF;

  SELECT count(*)
    INTO tombstone_function
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app'
     AND p.proname = 'enforce_users_immutable_columns';

  IF tombstone_function <> 1 THEN
    RAISE EXCEPTION 'app.enforce_users_immutable_columns is missing';
  END IF;

  SELECT pg_get_triggerdef(t.oid)
    INTO trigger_definition
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app'
     AND c.relname = 'users'
     AND t.tgname = 'users_immutable_columns'
   ORDER BY t.oid DESC
   LIMIT 1;

  IF trigger_definition IS NULL
     OR position('app.enforce_users_immutable_columns' IN trigger_definition) = 0 THEN
    RAISE EXCEPTION 'users_immutable_columns must use app.enforce_users_immutable_columns';
  END IF;
END
$$;
