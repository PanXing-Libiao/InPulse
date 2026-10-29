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
  WBC01: "没有找到对应的绑定码，请在 InPulse 里重新生成后复制完整绑定码发送。",
  WBC02: "这个绑定码已经用过了，请在 InPulse 里重新生成。",
  WBC04: "对应的 InPulse 账号已停用，无法绑定。",
  WBC05: "这个绑定码已过期，请在 InPulse 里重新生成。",
  WBC06: "当前企业微信账号已绑定其他 InPulse 用户。",
  UNKNOWN: "绑定失败，请稍后再试。",
};
