SET LOCAL ROLE app_owner;

-- ADR-106：项目群通知收敛为 Webhook-only。
-- 口径：
--   1. 历史 BOT 目标全部置为 REVOKED，保留行与投递历史，不物理删除；
--   2. 历史待用项目群绑定码立即作废，后续 app_runtime 不再有签发或修改权限；
--   3. 历史 BOT 的 PENDING 投递行置为 FAILED，避免桥接继续尝试不存在的能力；
--   4. 数据库约束封死新的 ACTIVE BOT 目标；Webhook 目标与五类通知开关不变；
--   5. 管理员更换机器人仍撤销个人绑定，但不再触碰项目群目标；返回的
--      revoked_project_groups 固定为 0，仅为保持既有 API 契约兼容。

ALTER TABLE app.project_wecom_groups
  ALTER COLUMN channel_type SET DEFAULT 'WEBHOOK';

UPDATE app.project_wecom_groups
   SET status = 'REVOKED',
       revoked_at = now(),
       updated_at = now(),
       row_version = row_version + 1
 WHERE channel_type = 'BOT'
   AND status = 'ACTIVE';

UPDATE app.project_wecom_binding_codes
   SET consumed_at = now(),
       consumed_by_wecom_userid = NULL,
       consumed_by_user_id = NULL
 WHERE consumed_at IS NULL;

UPDATE app.wecom_group_deliveries AS d
   SET status = 'FAILED',
       attempts = d.attempts + 1,
       last_error = '项目群已改为仅 Webhook，历史智能机器人投递不再发送'
  FROM app.project_wecom_groups AS g
 WHERE g.id = d.group_binding_id
   AND g.channel_type = 'BOT'
   AND d.status = 'PENDING';

ALTER TABLE app.project_wecom_groups
  ADD CONSTRAINT project_wecom_groups_webhook_only_check
    CHECK (channel_type = 'WEBHOOK' OR status <> 'ACTIVE');

COMMENT ON COLUMN app.project_wecom_groups.channel_type IS
  'ADR-106：项目群仅使用 WEBHOOK；BOT 仅保留历史行且不得再进入 ACTIVE。';

CREATE OR REPLACE FUNCTION app.revoke_wecom_bindings_on_robot_change()
RETURNS TABLE (
  revoked_user_bindings INTEGER,
  revoked_project_groups INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $$
DECLARE
  v_user_bindings INTEGER := 0;
BEGIN
  UPDATE app.user_wecom_bindings
     SET status = 'REVOKED',
         revoked_at = now(),
         updated_at = now(),
         row_version = row_version + 1
   WHERE status = 'ACTIVE';
  GET DIAGNOSTICS v_user_bindings = ROW_COUNT;

  -- 项目群已不再使用智能机器人；Webhook 绑定不受机器人凭据变更影响。
  RETURN QUERY SELECT v_user_bindings, 0;
END;
$$;

REVOKE INSERT, UPDATE ON app.project_wecom_binding_codes FROM app_runtime;
REVOKE ALL ON FUNCTION app.redeem_project_wecom_binding_code(BYTEA, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.redeem_project_wecom_binding_code(BYTEA, TEXT, TEXT) FROM app_runtime;
REVOKE ALL ON FUNCTION app.revoke_wecom_bindings_on_robot_change() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.revoke_wecom_bindings_on_robot_change() TO app_runtime;

DO $$
DECLARE
  active_bot_count INTEGER;
  live_code_count INTEGER;
  pending_bot_count INTEGER;
  channel_default TEXT;
  expected_channel_default TEXT;
  constraint_definition TEXT;
  revoke_definition TEXT;
  runtime_can_write_codes BOOLEAN;
  runtime_can_redeem BOOLEAN;
BEGIN
  SELECT count(*)::INTEGER
    INTO active_bot_count
    FROM app.project_wecom_groups
   WHERE channel_type = 'BOT'
     AND status = 'ACTIVE';
  IF active_bot_count <> 0 THEN
    RAISE EXCEPTION
      'ADR-106 forbids ACTIVE BOT targets, found %',
      active_bot_count;
  END IF;

  SELECT count(*)::INTEGER
    INTO live_code_count
    FROM app.project_wecom_binding_codes
   WHERE consumed_at IS NULL;
  IF live_code_count <> 0 THEN
    RAISE EXCEPTION
      'ADR-106 must consume every live project wecom binding code, found %',
      live_code_count;
  END IF;

  SELECT count(*)::INTEGER
    INTO pending_bot_count
    FROM app.wecom_group_deliveries AS d
    JOIN app.project_wecom_groups AS g ON g.id = d.group_binding_id
   WHERE d.status = 'PENDING'
     AND g.channel_type = 'BOT';
  IF pending_bot_count <> 0 THEN
    RAISE EXCEPTION
      'ADR-106 must fail every pending BOT delivery, found %',
      pending_bot_count;
  END IF;

  SELECT column_default
    INTO channel_default
    FROM information_schema.columns
   WHERE table_schema = 'app'
     AND table_name = 'project_wecom_groups'
     AND column_name = 'channel_type';
  expected_channel_default := quote_literal('WEBHOOK'::text) || '::text';
  IF channel_default IS DISTINCT FROM expected_channel_default THEN
    RAISE EXCEPTION
      'project_wecom_groups.channel_type must default to WEBHOOK, got %',
      channel_default;
  END IF;

  SELECT pg_get_constraintdef(c.oid)
    INTO constraint_definition
    FROM pg_constraint AS c
   WHERE c.conrelid = 'app.project_wecom_groups'::regclass
     AND c.conname = 'project_wecom_groups_webhook_only_check';
  IF constraint_definition IS NULL
     OR position('WEBHOOK' IN constraint_definition) = 0
     OR position('ACTIVE' IN constraint_definition) = 0 THEN
    RAISE EXCEPTION
      'project_wecom_groups_webhook_only_check is missing or incomplete';
  END IF;

  SELECT pg_get_functiondef(p.oid)
    INTO revoke_definition
    FROM pg_proc AS p
   WHERE p.oid =
     'app.revoke_wecom_bindings_on_robot_change()'::regprocedure;
  IF revoke_definition IS NULL
     OR position('project_wecom_groups' IN revoke_definition) <> 0 THEN
    RAISE EXCEPTION
      'app.revoke_wecom_bindings_on_robot_change must not touch project groups';
  END IF;

  SELECT
    has_table_privilege('app_runtime', 'app.project_wecom_binding_codes', 'INSERT')
    OR has_table_privilege('app_runtime', 'app.project_wecom_binding_codes', 'UPDATE')
    INTO runtime_can_write_codes;
  IF runtime_can_write_codes THEN
    RAISE EXCEPTION
      'app_runtime must not write historical project wecom binding codes';
  END IF;

  SELECT has_function_privilege(
           'app_runtime',
           'app.redeem_project_wecom_binding_code(bytea, text, text)',
           'EXECUTE'
         )
    INTO runtime_can_redeem;
  IF runtime_can_redeem THEN
    RAISE EXCEPTION
      'app_runtime must not execute project wecom binding code redemption';
  END IF;
END
$$;
