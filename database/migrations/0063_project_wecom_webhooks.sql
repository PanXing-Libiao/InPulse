SET LOCAL ROLE app_owner;

-- ADR-105：在现有项目群目标表上增加企业微信 Webhook 通道。
-- 口径：
--   1. channel_type=BOT 保持 ADR-077 的“一个项目至多一个 ACTIVE 群、一个群至多一个 ACTIVE 项目”；
--   2. channel_type=WEBHOOK 允许一个项目多个 ACTIVE 目标，但同一 URL 指纹全局至多一个 ACTIVE 目标；
--   3. Webhook URL 只存 AES-256-GCM 密文、主密钥版本、SHA-256 指纹和尾 4 位提示，完整 URL 永不入库；
--   4. 兑换项目绑定码与管理员更换机器人只处理 BOT 目标，不得撤销 Webhook；
--   5. 投递表结构无需修改，桥接按目标 channel_type 选择 aibot_send_msg 或 HTTP POST。

ALTER TABLE app.project_wecom_groups
  ADD COLUMN channel_type TEXT NOT NULL DEFAULT 'BOT',
  ADD COLUMN webhook_label TEXT,
  ADD COLUMN webhook_url_ciphertext BYTEA,
  ADD COLUMN webhook_url_key_version INTEGER,
  ADD COLUMN webhook_url_fingerprint BYTEA,
  ADD COLUMN webhook_url_hint TEXT;

ALTER TABLE app.project_wecom_groups
  ALTER COLUMN wecom_chat_id DROP NOT NULL;

ALTER TABLE app.project_wecom_groups
  DROP CONSTRAINT project_wecom_groups_chat_id_check;

DROP INDEX app.project_wecom_groups_active_project_idx;
DROP INDEX app.project_wecom_groups_active_chat_idx;

ALTER TABLE app.project_wecom_groups
  ADD CONSTRAINT project_wecom_groups_channel_type_check
    CHECK (channel_type IN ('BOT', 'WEBHOOK')),
  ADD CONSTRAINT project_wecom_groups_channel_shape_check
    CHECK (
      (
        channel_type = 'BOT'
        AND wecom_chat_id IS NOT NULL
        AND length(wecom_chat_id) BETWEEN 1 AND 128
        AND webhook_label IS NULL
        AND webhook_url_ciphertext IS NULL
        AND webhook_url_key_version IS NULL
        AND webhook_url_fingerprint IS NULL
        AND webhook_url_hint IS NULL
      )
      OR (
        channel_type = 'WEBHOOK'
        AND wecom_chat_id IS NULL
        AND webhook_label IS NOT NULL
        AND length(webhook_label) BETWEEN 1 AND 80
        AND webhook_url_ciphertext IS NOT NULL
        AND octet_length(webhook_url_ciphertext) BETWEEN 29 AND 4096
        AND webhook_url_key_version IS NOT NULL
        AND webhook_url_key_version > 0
        AND webhook_url_fingerprint IS NOT NULL
        AND octet_length(webhook_url_fingerprint) = 32
        AND webhook_url_hint IS NOT NULL
        AND length(webhook_url_hint) BETWEEN 4 AND 12
      )
    );

CREATE UNIQUE INDEX project_wecom_groups_active_project_idx
  ON app.project_wecom_groups (project_id)
  WHERE status = 'ACTIVE' AND channel_type = 'BOT';
CREATE UNIQUE INDEX project_wecom_groups_active_chat_idx
  ON app.project_wecom_groups (wecom_chat_id)
  WHERE status = 'ACTIVE' AND channel_type = 'BOT';
CREATE UNIQUE INDEX project_wecom_groups_active_webhook_fingerprint_idx
  ON app.project_wecom_groups (webhook_url_fingerprint)
  WHERE status = 'ACTIVE' AND channel_type = 'WEBHOOK';
CREATE INDEX project_wecom_groups_active_webhook_project_idx
  ON app.project_wecom_groups (project_id)
  WHERE status = 'ACTIVE' AND channel_type = 'WEBHOOK';

COMMENT ON COLUMN app.project_wecom_groups.channel_type IS
  'ADR-105 项目群目标通道：BOT 智能机器人，WEBHOOK 群机器人。';
COMMENT ON COLUMN app.project_wecom_groups.webhook_url_ciphertext IS
  'ADR-105 Webhook URL 密文，AAD=app.project_wecom_groups.webhook_url。';

CREATE OR REPLACE FUNCTION app.redeem_project_wecom_binding_code(
  p_code_hash BYTEA,
  p_wecom_chat_id TEXT,
  p_wecom_userid TEXT
)
RETURNS TABLE (
  project_id INTEGER,
  project_name TEXT,
  rebound BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $$
DECLARE
  v_code app.project_wecom_binding_codes%ROWTYPE;
  v_binder_user_id INTEGER;
  v_binder_status TEXT;
  v_binder_is_admin BOOLEAN;
  v_project_name TEXT;
  v_chat_row app.project_wecom_groups%ROWTYPE;
  v_project_row app.project_wecom_groups%ROWTYPE;
  v_rebound BOOLEAN := FALSE;
BEGIN
  IF p_code_hash IS NULL OR octet_length(p_code_hash) <> 32 THEN
    RAISE EXCEPTION 'code hash must be 32 bytes' USING ERRCODE = 'PWG07';
  END IF;
  IF p_wecom_chat_id IS NULL
     OR length(p_wecom_chat_id) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'wecom chat id is invalid' USING ERRCODE = 'PWG07';
  END IF;
  IF p_wecom_userid IS NULL
     OR length(p_wecom_userid) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'wecom userid is invalid' USING ERRCODE = 'PWG07';
  END IF;

  -- 固定锁序（ADR-077）：码行 -> 发送者个人绑定行 -> 群绑定行（chat -> project）。
  SELECT c.*
    INTO v_code
    FROM app.project_wecom_binding_codes AS c
   WHERE c.code_hash = p_code_hash
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'project binding code not found' USING ERRCODE = 'PWG01';
  END IF;
  IF v_code.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'project binding code already used' USING ERRCODE = 'PWG02';
  END IF;
  IF v_code.expires_at <= now() THEN
    RAISE EXCEPTION 'project binding code expired' USING ERRCODE = 'PWG06';
  END IF;

  SELECT b.user_id, u.status, u.is_admin
    INTO v_binder_user_id, v_binder_status, v_binder_is_admin
    FROM app.user_wecom_bindings AS b
    JOIN app.users AS u ON u.id = b.user_id
   WHERE b.wecom_userid = p_wecom_userid
     AND b.status = 'ACTIVE'
   FOR UPDATE OF b;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'wecom userid has no active binding'
      USING ERRCODE = 'PWG03';
  END IF;
  IF v_binder_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'binder user is not active' USING ERRCODE = 'PWG03';
  END IF;

  IF NOT v_binder_is_admin THEN
    PERFORM 1
      FROM app.project_members AS m
     WHERE m.project_id = v_code.project_id
       AND m.user_id = v_binder_user_id
       AND m.status = 'ACTIVE';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'binder is not an active project member'
        USING ERRCODE = 'PWG04';
    END IF;
  END IF;

  SELECT g.*
    INTO v_chat_row
    FROM app.project_wecom_groups AS g
   WHERE g.wecom_chat_id = p_wecom_chat_id
     AND g.channel_type = 'BOT'
     AND g.status = 'ACTIVE'
   FOR UPDATE;

  IF FOUND AND v_chat_row.project_id <> v_code.project_id THEN
    RAISE EXCEPTION 'wecom chat id already bound to another project'
      USING ERRCODE = 'PWG05';
  END IF;

  SELECT g.*
    INTO v_project_row
    FROM app.project_wecom_groups AS g
   WHERE g.project_id = v_code.project_id
     AND g.channel_type = 'BOT'
     AND g.status = 'ACTIVE'
   FOR UPDATE;

  IF FOUND THEN
    IF v_project_row.wecom_chat_id = p_wecom_chat_id THEN
      -- 幂等：该群已是本项目绑定，重复兑换只消费新码，不改绑定行。
      UPDATE app.project_wecom_binding_codes AS c
         SET consumed_at = now(),
             consumed_by_wecom_userid = p_wecom_userid,
             consumed_by_user_id = v_binder_user_id
       WHERE c.project_id = v_code.project_id;
      SELECT p.name INTO v_project_name
        FROM app.projects AS p
       WHERE p.id = v_code.project_id;
      RETURN QUERY SELECT v_code.project_id, v_project_name, FALSE;
      RETURN;
    END IF;

    -- 换绑：旧群 REVOKED，投递历史保留在旧绑定行上。
    UPDATE app.project_wecom_groups AS g
       SET status = 'REVOKED',
           revoked_at = now(),
           updated_at = now(),
           row_version = g.row_version + 1
     WHERE g.id = v_project_row.id;
    v_rebound := TRUE;
  END IF;

  INSERT INTO app.project_wecom_groups
    (project_id, channel_type, wecom_chat_id, bound_by_user_id)
  VALUES (v_code.project_id, 'BOT', p_wecom_chat_id, v_binder_user_id);

  UPDATE app.project_wecom_binding_codes AS c
     SET consumed_at = now(),
         consumed_by_wecom_userid = p_wecom_userid,
         consumed_by_user_id = v_binder_user_id
   WHERE c.project_id = v_code.project_id;

  SELECT p.name INTO v_project_name
    FROM app.projects AS p
   WHERE p.id = v_code.project_id;
  RETURN QUERY SELECT v_code.project_id, v_project_name, v_rebound;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'project wecom group binding conflict'
      USING ERRCODE = 'PWG08';
END;
$$;

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
  v_project_groups INTEGER := 0;
BEGIN
  UPDATE app.user_wecom_bindings
     SET status = 'REVOKED',
         revoked_at = now(),
         updated_at = now(),
         row_version = row_version + 1
   WHERE status = 'ACTIVE';
  GET DIAGNOSTICS v_user_bindings = ROW_COUNT;

  UPDATE app.project_wecom_groups
     SET status = 'REVOKED',
         revoked_at = now(),
         updated_at = now(),
         row_version = row_version + 1
   WHERE status = 'ACTIVE'
     AND channel_type = 'BOT';
  GET DIAGNOSTICS v_project_groups = ROW_COUNT;

  RETURN QUERY SELECT v_user_bindings, v_project_groups;
END;
$$;

REVOKE ALL ON FUNCTION app.redeem_project_wecom_binding_code(BYTEA, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.redeem_project_wecom_binding_code(BYTEA, TEXT, TEXT) TO app_runtime;
REVOKE ALL ON FUNCTION app.revoke_wecom_bindings_on_robot_change() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.revoke_wecom_bindings_on_robot_change() TO app_runtime;

DO $$
DECLARE
  channel_type_default TEXT;
  active_bot_project_idx INTEGER;
  active_bot_chat_idx INTEGER;
  active_webhook_fingerprint_idx INTEGER;
  active_webhook_project_idx INTEGER;
  redeem_definition TEXT;
  revoke_definition TEXT;
  runtime_ok BOOLEAN;
BEGIN
  SELECT column_default
    INTO channel_type_default
    FROM information_schema.columns
   WHERE table_schema = 'app'
     AND table_name = 'project_wecom_groups'
     AND column_name = 'channel_type';

  IF channel_type_default IS DISTINCT FROM '''BOT''::text' THEN
    RAISE EXCEPTION
      'project_wecom_groups.channel_type must default to BOT, got %',
      channel_type_default;
  END IF;

  SELECT count(*) INTO active_bot_project_idx
    FROM pg_indexes
   WHERE schemaname = 'app'
     AND tablename = 'project_wecom_groups'
     AND indexname = 'project_wecom_groups_active_project_idx';
  SELECT count(*) INTO active_bot_chat_idx
    FROM pg_indexes
   WHERE schemaname = 'app'
     AND tablename = 'project_wecom_groups'
     AND indexname = 'project_wecom_groups_active_chat_idx';
  SELECT count(*) INTO active_webhook_fingerprint_idx
    FROM pg_indexes
   WHERE schemaname = 'app'
     AND tablename = 'project_wecom_groups'
     AND indexname = 'project_wecom_groups_active_webhook_fingerprint_idx';
  SELECT count(*) INTO active_webhook_project_idx
    FROM pg_indexes
   WHERE schemaname = 'app'
     AND tablename = 'project_wecom_groups'
     AND indexname = 'project_wecom_groups_active_webhook_project_idx';

  IF active_bot_project_idx <> 1
     OR active_bot_chat_idx <> 1
     OR active_webhook_fingerprint_idx <> 1
     OR active_webhook_project_idx <> 1 THEN
    RAISE EXCEPTION 'ADR-105 project wecom group indexes are incomplete';
  END IF;

  SELECT pg_get_functiondef(p.oid)
    INTO redeem_definition
    FROM pg_proc p
   WHERE p.oid =
     'app.redeem_project_wecom_binding_code(bytea, text, text)'::regprocedure;
  IF redeem_definition IS NULL
     OR position('channel_type = ''BOT''' IN redeem_definition) = 0 THEN
    RAISE EXCEPTION
      'app.redeem_project_wecom_binding_code must restrict itself to BOT targets';
  END IF;

  SELECT pg_get_functiondef(p.oid)
    INTO revoke_definition
    FROM pg_proc p
   WHERE p.oid =
     'app.revoke_wecom_bindings_on_robot_change()'::regprocedure;
  IF revoke_definition IS NULL
     OR position('channel_type = ''BOT''' IN revoke_definition) = 0 THEN
    RAISE EXCEPTION
      'app.revoke_wecom_bindings_on_robot_change must only revoke BOT targets';
  END IF;

  SELECT
    has_table_privilege('app_runtime', 'app.project_wecom_groups', 'SELECT')
    AND has_table_privilege('app_runtime', 'app.project_wecom_groups', 'INSERT')
    AND has_table_privilege('app_runtime', 'app.project_wecom_groups', 'UPDATE')
    AND NOT has_table_privilege('app_runtime', 'app.project_wecom_groups', 'DELETE')
    AND has_table_privilege('app_runtime', 'app.wecom_group_deliveries', 'SELECT')
    AND has_table_privilege('app_runtime', 'app.wecom_group_deliveries', 'INSERT')
    AND has_table_privilege('app_runtime', 'app.wecom_group_deliveries', 'UPDATE')
    AND NOT has_table_privilege('app_runtime', 'app.wecom_group_deliveries', 'DELETE')
    INTO runtime_ok;
  IF NOT runtime_ok THEN
    RAISE EXCEPTION
      'app_runtime must retain SELECT / INSERT / UPDATE and no DELETE on project wecom group tables';
  END IF;
END
$$;
