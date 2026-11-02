SET LOCAL ROLE app_owner;

-- ADR-110：AI 辅助转换的文本模型分流与分场景输出上限。
-- 1. text_model 可空：为空时纯文本请求回退到 model；带截图的请求始终使用 model；
-- 2. 不改写既有行，部署后行为保持不变，由管理员在设置页选择更快的文本模型；
-- 3. 列长度与 model 保持同一上限，避免异常配置撑大管理端响应。

ALTER TABLE app.ai_assist_settings
  ADD COLUMN text_model TEXT NULL;

ALTER TABLE app.ai_assist_settings
  ADD CONSTRAINT ai_assist_settings_text_model_check
    CHECK (text_model IS NULL OR length(text_model) BETWEEN 1 AND 200);

DO $do$
DECLARE
  column_nullable TEXT;
  constraint_count INTEGER;
BEGIN
  SELECT is_nullable
    INTO column_nullable
    FROM information_schema.columns
   WHERE table_schema = $schema$app$schema$
     AND table_name = $table$ai_assist_settings$table$
     AND column_name = $column$text_model$column$;

  IF column_nullable IS DISTINCT FROM $yes$YES$yes$ THEN
    RAISE EXCEPTION $msg$app.ai_assist_settings.text_model must exist and be nullable$msg$;
  END IF;

  SELECT count(*)
    INTO constraint_count
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = $schema$app$schema$
     AND t.relname = $table$ai_assist_settings$table$
     AND c.conname = $constraint$ai_assist_settings_text_model_check$constraint$
     AND c.contype = $type$c$type$;

  IF constraint_count <> 1 THEN
    RAISE EXCEPTION $msg$ai_assist_settings_text_model_check is missing$msg$;
  END IF;
END
$do$;
