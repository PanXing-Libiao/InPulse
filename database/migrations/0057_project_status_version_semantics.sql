-- ADR-092：项目状态不是内容版本的一部分。
-- 口径：
--   1. 纯状态变更（只改 status / updated_at，row_version 保持）允许通过；
--   2. 任何其他列变化仍必须恰好 row_version + 1；
--   3. 首次任务完成会写 first_task_completed_at，因此即使同时升级状态也必须 +1；
--   4. 其他表的 require_next_row_version 语义不变。

SET LOCAL ROLE app_owner;

CREATE OR REPLACE FUNCTION app.require_project_row_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
BEGIN
  IF NEW.row_version = OLD.row_version THEN
    IF NEW.status IS DISTINCT FROM OLD.status
      AND (to_jsonb(NEW) - 'status' - 'updated_at' - 'row_version')
          IS NOT DISTINCT FROM
          (to_jsonb(OLD) - 'status' - 'updated_at' - 'row_version')
    THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION '%.row_version must advance for non-status updates (% -> %)',
      TG_TABLE_NAME, OLD.row_version, NEW.row_version
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION '%.row_version must advance exactly once (% -> %)',
      TG_TABLE_NAME, OLD.row_version, NEW.row_version
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION app.require_project_row_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.require_project_row_version() TO app_runtime;

DROP TRIGGER projects_row_version ON app.projects;
CREATE TRIGGER projects_row_version
BEFORE UPDATE ON app.projects
FOR EACH ROW EXECUTE FUNCTION app.require_project_row_version();

COMMENT ON FUNCTION app.require_project_row_version() IS
  'ADR-092：项目纯状态变更可保持 row_version；内容更新必须恰好递增一次。';
