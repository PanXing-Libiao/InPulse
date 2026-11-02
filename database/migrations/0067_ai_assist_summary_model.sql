SET LOCAL ROLE app_owner;

-- ADR-110：A/B 实测后把文本模型收窄为迭代总结专用。
-- 任务助手与文档导入继续使用 model；只有迭代总结读取 summary_model。
-- 0066 已可能被本地或测试库应用，本迁移用重命名收敛，不修改历史迁移。

ALTER TABLE app.ai_assist_settings
  RENAME COLUMN text_model TO summary_model;

ALTER TABLE app.ai_assist_settings
  RENAME CONSTRAINT ai_assist_settings_text_model_check TO ai_assist_settings_summary_model_check;

DO $do$
DECLARE
  summary_nullable TEXT;
  text_model_exists INTEGER;
  constraint_count INTEGER;
BEGIN
  SELECT is_nullable
    INTO summary_nullable
    FROM information_schema.columns
   WHERE table_schema = $schema$app$schema$
     AND table_name = $table$ai_assist_settings$table$
     AND column_name = $column$summary_model$column$;

  IF summary_nullable IS DISTINCT FROM $yes$YES$yes$ THEN
    RAISE EXCEPTION $msg$app.ai_assist_settings.summary_model must exist and be nullable$msg$;
  END IF;

  SELECT count(*)
    INTO text_model_exists
    FROM information_schema.columns
   WHERE table_schema = $schema$app$schema$
     AND table_name = $table$ai_assist_settings$table$
     AND column_name = $column$text_model$column$;

  IF text_model_exists <> 0 THEN
    RAISE EXCEPTION $msg$app.ai_assist_settings.text_model must be renamed$msg$;
  END IF;

  SELECT count(*)
    INTO constraint_count
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = $schema$app$schema$
     AND t.relname = $table$ai_assist_settings$table$
     AND c.conname = $constraint$ai_assist_settings_summary_model_check$constraint$
     AND c.contype = $type$c$type$;

  IF constraint_count <> 1 THEN
    RAISE EXCEPTION $msg$ai_assist_settings_summary_model_check is missing$msg$;
  END IF;
END
$do$;
