// ADR-069 绑定码兑换核心：长连接桥接与自检脚本共用，不包含 WS / 推送逻辑。
import { createHash } from "node:crypto";

/** 生成端只产出 Crockford Base32；I/L/O/U 属于抄错，但也放行去问库（会得到 WBC01）。 */
const BINDING_CODE_CANDIDATE = /^[0-9A-Z]{16}$/;

/**
 * 与仓库侧 hashWecomBindingCode 保持同一标准形态：大写、去掉空白与常见
 * 连字符/破折号变体后必须是 16 位；此处宽容度只会多去掉干扰符号，
 * 「标准码 + 干扰符号」的输入与仓库侧得出相同 Hash，其余判为不是绑定码。
 */
export function normalizeBindingCode(rawText) {
  const normalized = String(rawText)
    .trim()
    .toUpperCase()
    .replace(/[\s\u2010-\u2015\u2212\uFF0D-]+/g, "");
  return BINDING_CODE_CANDIDATE.test(normalized) ? normalized : null;
}

/** 绑定码 SHA-256；输入不是绑定码形态时返回 null。 */
export function hashBindingCode(rawText) {
  const normalized = normalizeBindingCode(rawText);
  if (normalized === null) return null;
  return createHash("sha256").update(normalized, "utf8").digest();
}

/**
 * 兑换绑定码：outcome 为 bound / failed / not-a-code；
 * failed 时 sqlState 取 WBC01/02/04/05/06 或 UNKNOWN。
 * 兑换在 app.redeem_wecom_binding_code（SECURITY DEFINER）单事务内完成。
 */
export async function redeemBindingCode(queryable, rawText, wecomUserId) {
  const codeHash = hashBindingCode(rawText);
  if (codeHash === null) return { outcome: "not-a-code" };
  try {
    const result = await queryable.query(
      "SELECT user_id, display_name FROM app.redeem_wecom_binding_code($1, $2)",
      [codeHash, wecomUserId],
    );
    const row = result.rows[0];
    return {
      outcome: "bound",
      userId: row ? row.user_id : null,
      displayName: row && row.display_name ? String(row.display_name) : "同事",
    };
  } catch (error) {
    const sqlState = error && typeof error.code === "string" ? error.code : "";
    const known = ["WBC01", "WBC02", "WBC04", "WBC05", "WBC06"];
    return {
      outcome: "failed",
      sqlState: known.includes(sqlState) ? sqlState : "UNKNOWN",
      error: error,
    };
  }
}

export const BINDING_FAILURE_REASONS = {
  WBC01:
    "没有找到对应的绑定码，请在 InPulse 里重新生成后复制完整绑定码发送（项目群绑定码请在目标群里 @机器人 后发送）。",
  WBC02: "这个绑定码已经用过了，请在 InPulse 里重新生成。",
  WBC04: "对应的 InPulse 账号已停用，无法绑定。",
  WBC05: "这个绑定码已过期，请在 InPulse 里重新生成。",
  WBC06: "当前企业微信账号已绑定其他 InPulse 用户。",
  UNKNOWN: "绑定失败，请稍后再试。",
};

/** 群消息里的绑定码提取：先按整段文本严格归一化，再容忍「@机器人 码」前缀，最后从后往前逐词尝试；不是绑定码时返回 null。 */
export function extractBindingCode(rawText) {
  const text = String(rawText);
  const direct = normalizeBindingCode(text);
  if (direct !== null) return direct;
  const withoutMentions = text.replace(/^(?:\s*@[^\s@]*\s+)+/u, "");
  const stripped = normalizeBindingCode(withoutMentions);
  if (stripped !== null) return stripped;
  const tokens = text.split(/\s+/u).filter((token) => token.length > 0);
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = normalizeBindingCode(tokens[index]);
    if (token !== null) return token;
  }
  return null;
}

/**
 * 兑换项目群绑定码（ADR-077）：outcome 为 bound / failed / not-a-code；
 * failed 时 sqlState 取 PWG01～PWG08 或 UNKNOWN。
 * 兑换在 app.redeem_project_wecom_binding_code（SECURITY DEFINER）单事务内完成。
 */
export async function redeemProjectGroupCode(
  queryable,
  rawText,
  wecomChatId,
  wecomUserId,
) {
  const codeHash = hashBindingCode(extractBindingCode(rawText) || "");
  if (codeHash === null) return { outcome: "not-a-code" };
  try {
    const result = await queryable.query(
      "SELECT project_id, project_name, rebound FROM app.redeem_project_wecom_binding_code($1, $2, $3)",
      [codeHash, wecomChatId, wecomUserId],
    );
    const row = result.rows[0];
    return {
      outcome: "bound",
      projectId: row ? row.project_id : null,
      projectName: row && row.project_name ? String(row.project_name) : "项目",
      rebound: row ? row.rebound === true : false,
    };
  } catch (error) {
    const sqlState = error && typeof error.code === "string" ? error.code : "";
    const known = [
      "PWG01",
      "PWG02",
      "PWG03",
      "PWG04",
      "PWG05",
      "PWG06",
      "PWG07",
      "PWG08",
    ];
    return {
      outcome: "failed",
      sqlState: known.includes(sqlState) ? sqlState : "UNKNOWN",
      error: error,
    };
  }
}

export const PROJECT_BINDING_FAILURE_REASONS = {
  PWG01:
    "没有找到对应的项目绑定码，请在 InPulse 项目页重新生成后用「@机器人 + 绑定码」发送到目标群。",
  PWG02: "这个绑定码已经用过了，请在 InPulse 项目页重新生成。",
  PWG03:
    "你还没有可用的 InPulse 个人绑定（或账号已停用）。请先在与机器人的单聊里发送个人绑定码，完成后再回到本群发送项目绑定码。",
  PWG04: "你不是该项目的成员，无法为它绑定群。",
  PWG05: "本群已经绑定了其他项目，请先在原项目页解绑，或改用其他群。",
  PWG06: "绑定码已过期，请在 InPulse 项目页重新生成。",
  PWG07: "绑定参数不合法，请重新生成绑定码后再试。",
  PWG08: "绑定发生并发冲突，请稍后重试。",
  UNKNOWN: "绑定失败，请稍后再试。",
};
