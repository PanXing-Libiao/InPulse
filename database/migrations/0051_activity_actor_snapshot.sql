-- ADR-087：项目动态固化操作人身份快照。

-- 新写入的 USER 动态在 actor_snapshot 中保存操作人的 id / name / loginName，
-- 读取时优先使用该快照；用户行后续被物理删除，不再改变项目动态的展示名。
-- 历史行不补写快照，仍回退到实时用户目录。
--
-- 本迁移同时解除 activity_projection.actor_id 到 app.users 的外键，保留
-- actor_id 作为历史坐标；actor CHECK 等既有不变量不变。

SET LOCAL ROLE app_owner;

ALTER TABLE app.activity_projection
  ADD COLUMN actor_snapshot jsonb;

ALTER TABLE app.activity_projection
  ADD CONSTRAINT activity_projection_actor_snapshot_check
  CHECK (
    actor_snapshot IS NULL
    OR (
      actor_id IS NOT NULL
      AND jsonb_typeof(actor_snapshot) = 'object'
      AND pg_column_size(actor_snapshot) <= 4096
      AND jsonb_typeof(actor_snapshot->'id') = 'number'
      AND jsonb_typeof(actor_snapshot->'name') = 'string'
      AND jsonb_typeof(actor_snapshot->'loginName') = 'string'
      AND length(btrim(actor_snapshot->>'name')) BETWEEN 1 AND 200
      AND length(btrim(actor_snapshot->>'loginName')) BETWEEN 1 AND 100
      AND actor_snapshot->>'id' = actor_id::text
    )
  );

COMMENT ON COLUMN app.activity_projection.actor_snapshot IS
  'ADR-087 操作人事件时身份快照；仅用于显示，不参与授权。';

ALTER TABLE app.activity_projection
  DROP CONSTRAINT IF EXISTS activity_projection_actor_id_users_id_fk;

DO $$
DECLARE
  actor_fk_count INTEGER;
  snapshot_column_count INTEGER;
  snapshot_check_count INTEGER;
  snapshot_check_validated BOOLEAN;
BEGIN
  SELECT count(*)::INTEGER
    INTO actor_fk_count
    FROM pg_constraint
   WHERE conrelid = to_regclass('app.activity_projection')
     AND conname = 'activity_projection_actor_id_users_id_fk';

  IF actor_fk_count <> 0 THEN
    RAISE EXCEPTION 'activity_projection_actor_id_users_id_fk must be removed for ADR-087';
  END IF;

  SELECT count(*)::INTEGER
    INTO snapshot_column_count
    FROM pg_attribute
   WHERE attrelid = to_regclass('app.activity_projection')
     AND attname = 'actor_snapshot'
     AND attnum > 0
     AND NOT attisdropped;

  IF snapshot_column_count <> 1 THEN
    RAISE EXCEPTION 'activity_projection.actor_snapshot is missing for ADR-087';
  END IF;

  SELECT count(*)::INTEGER, bool_and(c.convalidated)
    INTO snapshot_check_count, snapshot_check_validated
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'app'
     AND t.relname = 'activity_projection'
     AND c.conname = 'activity_projection_actor_snapshot_check'
     AND c.contype = 'c';

  IF snapshot_check_count <> 1 OR NOT snapshot_check_validated THEN
    RAISE EXCEPTION 'activity_projection_actor_snapshot_check is missing or not validated';
  END IF;
END
$$;
