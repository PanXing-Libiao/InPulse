/**
 * 任务草稿助手回复与系统候选对齐。
 *
 * 模型偶尔在 reply 里断言「没有模块清单 / 模块暂时留空」，而服务端其实已经按
 * 项目模块清单匹配到候选。这类自相矛盾的句子会让紧跟其后的确认卡显得突兀，
 * 且用户会误以为没有匹配到模块。这里剔掉矛盾句，并补一句与候选一致的说明。
 * 没有候选时保持原文，避免影响「确实匹配不到」的正常提示。
 */
const MODULE_ABSENCE_CLAIM =
  /(模块清单未提供|没有(提供)?模块清单|未(提供|匹配到)模块|模块暂(时)?留空|暂未填模块)/u;

export function alignReplyWithModuleCandidates(
  reply: string,
  modules: readonly { readonly name: string }[],
): string {
  const first = modules[0];
  if (first === undefined) return reply;
  if (!MODULE_ABSENCE_CLAIM.test(reply)) return reply;
  const kept = reply
    .split(/(?<=[。！？；\n])/u)
    .filter((sentence) => !MODULE_ABSENCE_CLAIM.test(sentence))
    .join("")
    .trim();
  const addition =
    "已按当前项目的模块清单匹配到「" + first.name + "」，请确认是否用它。";
  return kept.length > 0 ? kept + addition : addition;
}
