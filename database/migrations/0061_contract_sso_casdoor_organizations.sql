SET LOCAL ROLE app_owner;

-- ADR-097：SSO 用户组织归属对齐 Casdoor 群组。
-- 口径：
--   1. organizations 区分 LOCAL 与 CASDOOR 来源；LOCAL 保留原名称唯一与可管理语义，
--      CASDOOR 以 owner + 完整群组路径为身份，支持父子层级且本地只读；
--   2. 新增 user_organizations 多对多成员关系；本地账号的 users.organization_id
--      一次性迁为 MANUAL，随后删除旧列；SSO 账号的旧手工归属不再保留，
--      由下一次成功 SSO 登录以 groups claim 重建，避免短暂违反来源真相；
--   3. CASDOOR 成员关系只能由 SSO 用户持有；LOCAL 成员关系只能由本地账号持有；
--   4. 历史迁移不回写；本迁移末尾以 fail closed 断言锁定列、约束、触发器与授权。

ALTER TABLE app.organizations
  ADD COLUMN source TEXT NOT NULL DEFAULT 'LOCAL',
  ADD COLUMN sso_owner TEXT,
  ADD COLUMN sso_group_path TEXT,
  ADD COLUMN sso_parent_path TEXT,
  ADD COLUMN parent_id INTEGER;

ALTER TABLE app.organizations
  ADD CONSTRAINT organizations_source_check
    CHECK (source IN ('LOCAL', 'CASDOOR')),
  ADD CONSTRAINT organizations_casdoor_shape_check
    CHECK (
      (
        source = 'LOCAL'
        AND sso_owner IS NULL
        AND sso_group_path IS NULL
        AND sso_parent_path IS NULL
        AND parent_id IS NULL
      )
      OR (
        source = 'CASDOOR'
        AND sso_owner IS NOT NULL
        AND char_length(sso_owner) BETWEEN 1 AND 100
        AND position('/' IN sso_owner) = 0
        AND btrim(sso_owner) <> ''
        AND sso_group_path IS NOT NULL
        AND char_length(sso_group_path) BETWEEN 3 AND 512
        AND sso_group_path ~ '^[^/]+(/[^/]+)+$'
        AND split_part(sso_group_path, '/', 1) = sso_owner
        AND cardinality(string_to_array(sso_group_path, '/')) BETWEEN 2 AND 20
        AND char_length(btrim(split_part(
          sso_group_path,
          '/',
          cardinality(string_to_array(sso_group_path, '/'))
        ))) BETWEEN 1 AND 100
        AND (
          (
            cardinality(string_to_array(sso_group_path, '/')) = 2
            AND sso_parent_path IS NULL
            AND parent_id IS NULL
          )
          OR (
            cardinality(string_to_array(sso_group_path, '/')) > 2
            AND sso_parent_path IS NOT NULL
            AND sso_parent_path ~ '^[^/]+(/[^/]+)+$'
            AND split_part(sso_parent_path, '/', 1) = sso_owner
            AND cardinality(string_to_array(sso_parent_path, '/'))
                = cardinality(string_to_array(sso_group_path, '/')) - 1
            AND sso_group_path = sso_parent_path || '/' || split_part(
              sso_group_path,
              '/',
              cardinality(string_to_array(sso_group_path, '/'))
            )
            AND parent_id IS NOT NULL
          )
        )
      )
    ),
  ADD CONSTRAINT organizations_parent_fk
    FOREIGN KEY (parent_id) REFERENCES app.organizations(id)
    ON DELETE RESTRICT ON UPDATE NO ACTION;

DROP INDEX app.organizations_name_key;
CREATE UNIQUE INDEX organizations_name_key
  ON app.organizations (lower(btrim(name)))
  WHERE source = 'LOCAL';

CREATE UNIQUE INDEX organizations_casdoor_path_key
  ON app.organizations (sso_owner, sso_group_path)
  WHERE source = 'CASDOOR';

CREATE INDEX organizations_parent_id_idx
  ON app.organizations (parent_id)
  WHERE parent_id IS NOT NULL;

-- CASDOOR 组织只允许按路径创建；插入时校验父行与 parent_id 一致，创建后不可改删。
CREATE FUNCTION app.guard_casdoor_organization()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
DECLARE
  v_parent_id INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.source = 'CASDOOR' THEN
      RAISE EXCEPTION 'CASDOOR organizations are read-only in InPulse'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.source IS DISTINCT FROM OLD.source THEN
    RAISE EXCEPTION 'organization source is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.source = 'CASDOOR' THEN
    IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
      RAISE EXCEPTION 'CASDOOR organizations are read-only in InPulse'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.source = 'CASDOOR' AND NEW.sso_parent_path IS NOT NULL THEN
    SELECT id
      INTO v_parent_id
      FROM app.organizations
     WHERE source = 'CASDOOR'
       AND sso_owner = NEW.sso_owner
       AND sso_group_path = NEW.sso_parent_path
     LIMIT 1;
    IF v_parent_id IS NULL OR NEW.parent_id IS DISTINCT FROM v_parent_id THEN
      RAISE EXCEPTION 'CASDOOR organization parent must match sso_parent_path'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER organizations_guard_casdoor
BEFORE INSERT OR UPDATE OR DELETE ON app.organizations
FOR EACH ROW EXECUTE FUNCTION app.guard_casdoor_organization();

CREATE TABLE app.user_organizations (
  user_id INTEGER NOT NULL,
  organization_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT user_organizations_pk PRIMARY KEY (user_id, organization_id),
  CONSTRAINT user_organizations_user_fk
    FOREIGN KEY (user_id) REFERENCES app.users(id)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT user_organizations_organization_fk
    FOREIGN KEY (organization_id) REFERENCES app.organizations(id)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT user_organizations_source_check
    CHECK (source IN ('MANUAL', 'CASDOOR'))
);

CREATE INDEX user_organizations_organization_idx
  ON app.user_organizations (organization_id, user_id);

-- SSO 账号只能持有 CASDOOR 群组关系；本地账号只能持有 LOCAL 手工关系。
CREATE FUNCTION app.guard_user_organization_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
DECLARE
  v_organization_source TEXT;
  v_sso_subject TEXT;
BEGIN
  SELECT source
    INTO v_organization_source
    FROM app.organizations
   WHERE id = NEW.organization_id;

  SELECT sso_subject
    INTO v_sso_subject
    FROM app.users
   WHERE id = NEW.user_id;

  IF v_organization_source = 'CASDOOR' THEN
    IF NEW.source <> 'CASDOOR' OR v_sso_subject IS NULL THEN
      RAISE EXCEPTION 'CASDOOR memberships require an SSO-managed user'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF v_organization_source = 'LOCAL' THEN
    IF NEW.source <> 'MANUAL' OR v_sso_subject IS NOT NULL THEN
      RAISE EXCEPTION 'LOCAL memberships require a local manual user'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'organization source is unavailable'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER user_organizations_guard_source
BEFORE INSERT OR UPDATE ON app.user_organizations
FOR EACH ROW EXECUTE FUNCTION app.guard_user_organization_membership();

CREATE TEMP TABLE migration_0061_expected_memberships ON COMMIT DROP AS
  SELECT count(*)::INTEGER AS expected_count
    FROM app.users
   WHERE organization_id IS NOT NULL
     AND sso_subject IS NULL;

INSERT INTO app.user_organizations (user_id, organization_id, source)
SELECT id, organization_id, 'MANUAL'
  FROM app.users
 WHERE organization_id IS NOT NULL
   AND sso_subject IS NULL;

ALTER TABLE app.users
  DROP CONSTRAINT users_deleted_state_check;

ALTER TABLE app.users
  DROP CONSTRAINT users_organization_fk;

ALTER TABLE app.users
  DROP COLUMN organization_id;

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
        AND is_admin = false
      )
    );

CREATE OR REPLACE FUNCTION app.enforce_users_immutable_columns()
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
       OR NEW.is_admin THEN
      RAISE EXCEPTION 'users may only be tombstoned once'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

REVOKE ALL ON app.user_organizations FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.user_organizations TO app_runtime;
GRANT SELECT ON app.user_organizations TO app_backup;

DO $$
DECLARE
  organization_column_count INTEGER;
  membership_count INTEGER;
  expected_membership_count INTEGER;
  local_name_index INTEGER;
  casdoor_path_index INTEGER;
  parent_fk_count INTEGER;
  membership_user_fk_count INTEGER;
  membership_user_fk_delete TEXT;
  membership_org_fk_count INTEGER;
  membership_org_fk_delete TEXT;
  tombstone_check INTEGER;
  tombstone_validated BOOLEAN;
  guard_trigger INTEGER;
  membership_guard_trigger INTEGER;
  invalid_membership_count INTEGER;
  user_fk_count INTEGER;
  non_cascade_user_fk_count INTEGER;
BEGIN
  SELECT count(*)
    INTO organization_column_count
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app'
     AND c.relname = 'users'
     AND a.attname = 'organization_id'
     AND a.attnum > 0
     AND NOT a.attisdropped;
  IF organization_column_count <> 0 THEN
    RAISE EXCEPTION 'app.users.organization_id must be removed';
  END IF;

  SELECT expected_count INTO expected_membership_count
    FROM migration_0061_expected_memberships;
  SELECT count(*)::INTEGER INTO membership_count
    FROM app.user_organizations;
  IF membership_count <> expected_membership_count THEN
    RAISE EXCEPTION
      'user organization migration expected % rows, found %',
      expected_membership_count,
      membership_count;
  END IF;

  SELECT count(*) INTO local_name_index
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app'
     AND c.relname = 'organizations_name_key'
     AND c.relkind = 'i';
  IF local_name_index <> 1 THEN
    RAISE EXCEPTION 'organizations_name_key is missing';
  END IF;

  SELECT count(*) INTO casdoor_path_index
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app'
     AND c.relname = 'organizations_casdoor_path_key'
     AND c.relkind = 'i';
  IF casdoor_path_index <> 1 THEN
    RAISE EXCEPTION 'organizations_casdoor_path_key is missing';
  END IF;

  SELECT count(*) INTO parent_fk_count
    FROM pg_constraint
   WHERE conrelid = 'app.organizations'::regclass
     AND conname = 'organizations_parent_fk'
     AND contype = 'f';
  IF parent_fk_count <> 1 THEN
    RAISE EXCEPTION 'organizations_parent_fk is missing';
  END IF;

  SELECT count(*)::INTEGER, min(confdeltype)::TEXT
    INTO membership_user_fk_count, membership_user_fk_delete
    FROM pg_constraint
   WHERE conrelid = 'app.user_organizations'::regclass
     AND conname = 'user_organizations_user_fk'
     AND contype = 'f';
  IF membership_user_fk_count <> 1 OR membership_user_fk_delete <> 'c' THEN
    RAISE EXCEPTION 'user_organizations_user_fk must cascade';
  END IF;

  SELECT count(*)::INTEGER, min(confdeltype)::TEXT
    INTO membership_org_fk_count, membership_org_fk_delete
    FROM pg_constraint
   WHERE conrelid = 'app.user_organizations'::regclass
     AND conname = 'user_organizations_organization_fk'
     AND contype = 'f';
  IF membership_org_fk_count <> 1 OR membership_org_fk_delete <> 'c' THEN
    RAISE EXCEPTION 'user_organizations_organization_fk must cascade';
  END IF;

  SELECT count(*), bool_and(convalidated)
    INTO tombstone_check, tombstone_validated
    FROM pg_constraint
   WHERE conrelid = 'app.users'::regclass
     AND conname = 'users_deleted_state_check'
     AND contype = 'c';
  IF tombstone_check <> 1 OR NOT tombstone_validated THEN
    RAISE EXCEPTION 'users_deleted_state_check is missing or invalid';
  END IF;

  SELECT count(*) INTO guard_trigger
    FROM pg_trigger
   WHERE tgrelid = 'app.organizations'::regclass
     AND tgname = 'organizations_guard_casdoor'
     AND NOT tgisinternal
     AND tgenabled = 'O';
  IF guard_trigger <> 1 THEN
    RAISE EXCEPTION 'organizations_guard_casdoor trigger is missing';
  END IF;

  SELECT count(*)
    INTO invalid_membership_count
    FROM app.user_organizations AS uo
    JOIN app.users AS u ON u.id = uo.user_id
    JOIN app.organizations AS o ON o.id = uo.organization_id
   WHERE (o.source = 'CASDOOR' AND (uo.source <> 'CASDOOR' OR u.sso_subject IS NULL))
      OR (o.source = 'LOCAL' AND (uo.source <> 'MANUAL' OR u.sso_subject IS NOT NULL));
  IF invalid_membership_count <> 0 THEN
    RAISE EXCEPTION 'user organization memberships violate ADR-097 source rules';
  END IF;

  SELECT count(*) INTO membership_guard_trigger
    FROM pg_trigger
   WHERE tgrelid = 'app.user_organizations'::regclass
     AND tgname = 'user_organizations_guard_source'
     AND NOT tgisinternal
     AND tgenabled = 'O';
  IF membership_guard_trigger <> 1 THEN
    RAISE EXCEPTION 'user_organizations_guard_source trigger is missing';
  END IF;

  SELECT count(*)::INTEGER,
         count(*) FILTER (WHERE confdeltype <> 'c')::INTEGER
    INTO user_fk_count, non_cascade_user_fk_count
    FROM pg_constraint
   WHERE confrelid = 'app.users'::regclass
     AND contype = 'f';
  IF user_fk_count <> 9 OR non_cascade_user_fk_count <> 0 THEN
    RAISE EXCEPTION
      'user foreign keys must be exactly nine cascade references after ADR-097, found % with % non-cascade',
      user_fk_count,
      non_cascade_user_fk_count;
  END IF;

  IF NOT (
    has_table_privilege('app_runtime', 'app.user_organizations', 'SELECT')
    AND has_table_privilege('app_runtime', 'app.user_organizations', 'INSERT')
    AND has_table_privilege('app_runtime', 'app.user_organizations', 'UPDATE')
    AND has_table_privilege('app_runtime', 'app.user_organizations', 'DELETE')
  ) THEN
    RAISE EXCEPTION 'app_runtime must manage app.user_organizations';
  END IF;

  IF NOT has_table_privilege('app_backup', 'app.user_organizations', 'SELECT')
     OR has_table_privilege('app_backup', 'app.user_organizations', 'INSERT')
     OR has_table_privilege('app_backup', 'app.user_organizations', 'UPDATE')
     OR has_table_privilege('app_backup', 'app.user_organizations', 'DELETE') THEN
    RAISE EXCEPTION 'app_backup must have read-only access to app.user_organizations';
  END IF;
END
$$;
