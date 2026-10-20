-- ADR-086：审计日志固化操作人身份快照。

-- 新写入的审计事件在 event_payload.actorSnapshot 中保存操作人的 id / name /
-- loginName；该字段属于 JCS 信封并受 record_hash 的 HMAC 覆盖。用户行被
-- 物理删除后，审计仍可独立展示当时的操作人身份，不再依赖实时用户表。
--
-- 本迁移只解除审计到用户的 RESTRICT 外键，保留 actor_type/actor_id 的
-- CHECK 与 (actor_id, occurred_at) 索引。历史行不补写快照、不重算哈希：
-- 迁移前的事件没有可验证的当时姓名，读取端仍回退到当前用户目录。

SET LOCAL ROLE app_owner;

ALTER TABLE app.audit_logs
  DROP CONSTRAINT IF EXISTS audit_logs_actor_id_users_id_fk;

DO $$
DECLARE
  actor_fk_count INTEGER;
  actor_check_count INTEGER;
  actor_check_validated BOOLEAN;
BEGIN
  SELECT count(*)::INTEGER
    INTO actor_fk_count
    FROM pg_constraint
   WHERE conrelid = to_regclass('app.audit_logs')
     AND conname = 'audit_logs_actor_id_users_id_fk';

  IF actor_fk_count <> 0 THEN
    RAISE EXCEPTION 'audit_logs_actor_id_users_id_fk must be removed for ADR-086';
  END IF;

  SELECT count(*)::INTEGER, bool_and(c.convalidated)
    INTO actor_check_count, actor_check_validated
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'app'
     AND t.relname = 'audit_logs'
     AND c.conname = 'audit_logs_actor_check'
     AND c.contype = 'c';

  IF actor_check_count <> 1 OR NOT actor_check_validated THEN
    RAISE EXCEPTION 'audit_logs_actor_check is missing or not validated';
  END IF;
END
$$;
