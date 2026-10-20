-- ADR-088：离职账号物理删除、个人操作数据级联与身份留档。

SET LOCAL ROLE app_owner;

-- 只保留最小身份信息，不保留邮箱、头像、凭据、组织、SSO subject 或个人资料。
-- 该表不是可登录账号，只用于历史业务记录在用户行消失后解析展示名。
CREATE TABLE app.deleted_user_identities (
  user_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  login_name TEXT NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT deleted_user_identities_name_check
    CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT deleted_user_identities_login_check
    CHECK (length(btrim(login_name)) BETWEEN 1 AND 100)
);

COMMENT ON TABLE app.deleted_user_identities IS
  'ADR-088 物理删除账号时保留的最小身份快照；不参与认证或授权。';

REVOKE ALL ON app.deleted_user_identities FROM PUBLIC;
GRANT SELECT ON app.deleted_user_identities TO app_runtime;
GRANT SELECT ON app.deleted_user_identities TO app_backup;

CREATE FUNCTION app.archive_deleted_user_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app'
AS $function$
BEGIN
  INSERT INTO app.deleted_user_identities(user_id, name, login_name, deleted_at)
  VALUES (OLD.id, OLD.name, OLD.login_name, clock_timestamp())
  ON CONFLICT (user_id) DO NOTHING;
  RETURN OLD;
END
$function$;

REVOKE ALL ON FUNCTION app.archive_deleted_user_identity() FROM PUBLIC;

CREATE TRIGGER users_archive_deleted_identity
BEFORE DELETE ON app.users
FOR EACH ROW EXECUTE FUNCTION app.archive_deleted_user_identity();

-- 先解除所有指向 users 的外键，再只给用户私有操作态恢复级联语义。
-- 业务历史保留原用户编号，并由 0052 的快照或 deleted_user_identities 解释。
DO $$
DECLARE
  relation_name REGCLASS;
  constraint_name NAME;
BEGIN
  FOR relation_name, constraint_name IN
    SELECT conrelid, conname
      FROM pg_constraint
     WHERE confrelid = 'app.users'::regclass
       AND contype = 'f'
     ORDER BY conrelid::regclass::text, conname
  LOOP
    EXECUTE format(
      'ALTER TABLE %s DROP CONSTRAINT %I',
      relation_name,
      constraint_name
    );
  END LOOP;
END
$$;

ALTER TABLE app.user_sessions
  ADD CONSTRAINT user_sessions_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES app.users(id)
  ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE app.user_totp_factors
  ADD CONSTRAINT user_totp_factors_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES app.users(id)
  ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE app.mfa_recovery_codes
  ADD CONSTRAINT mfa_recovery_codes_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES app.users(id)
  ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE app.idempotency_records
  ADD CONSTRAINT idempotency_records_actor_id_users_id_fk
  FOREIGN KEY (actor_id) REFERENCES app.users(id)
  ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE app.notifications
  ADD CONSTRAINT notifications_recipient_id_users_id_fk
  FOREIGN KEY (recipient_id) REFERENCES app.users(id)
  ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE app.wecom_binding_codes
  ADD CONSTRAINT wecom_binding_codes_user_fk
  FOREIGN KEY (user_id) REFERENCES app.users(id)
  ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE app.user_wecom_bindings
  ADD CONSTRAINT user_wecom_bindings_user_fk
  FOREIGN KEY (user_id) REFERENCES app.users(id)
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- app_runtime 不持有 users 的 DELETE；删除能力收在带前置条件的函数中。
CREATE FUNCTION app.delete_user_account(
  p_user_id INTEGER,
  p_expected_row_version INTEGER
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app'
AS $function$
DECLARE
  v_status TEXT;
  v_row_version INTEGER;
BEGIN
  SELECT u.status, u.row_version
    INTO v_status, v_row_version
    FROM app.users AS u
   WHERE u.id = p_user_id
     FOR UPDATE;

  IF NOT FOUND OR v_row_version <> p_expected_row_version THEN
    RETURN false;
  END IF;
  IF v_status <> 'DISABLED' THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM app.project_members AS pm
     WHERE pm.user_id = p_user_id
       AND pm.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'active project membership prevents user deletion'
      USING ERRCODE = '23514';
  END IF;

  DELETE FROM app.users WHERE id = p_user_id;
  RETURN FOUND;
END
$function$;

COMMENT ON FUNCTION app.delete_user_account(INTEGER, INTEGER) IS
  'ADR-088 物理删除已停用且无 ACTIVE 项目成员的账号；身份快照与业务历史保留。';

REVOKE ALL ON FUNCTION app.delete_user_account(INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.delete_user_account(INTEGER, INTEGER) TO app_runtime;

DO $$
DECLARE
  user_fk_count INTEGER;
  non_cascade_user_fk_count INTEGER;
BEGIN
  SELECT count(*)::INTEGER,
         count(*) FILTER (WHERE confdeltype <> 'c')::INTEGER
    INTO user_fk_count, non_cascade_user_fk_count
    FROM pg_constraint
   WHERE confrelid = 'app.users'::regclass
     AND contype = 'f';

  IF user_fk_count <> 7 OR non_cascade_user_fk_count <> 0 THEN
    RAISE EXCEPTION
      'user foreign keys must be exactly seven cascade references, found % with % non-cascade',
      user_fk_count,
      non_cascade_user_fk_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgrelid = 'app.users'::regclass
       AND tgname = 'users_archive_deleted_identity'
       AND NOT tgisinternal
       AND tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'users_archive_deleted_identity trigger is missing';
  END IF;
END
$$;
