export type ProjectKey = "p1" | "p2" | "p3" | "p4" | "p5" | "p6";

export type SearchEntityType =
  | "PROJECT"
  | "MODULE"
  | "TASK"
  | "CHANGE_RECORD"
  | "EXTERNAL_LINK"
  | "TASK_GROUP";

export type QueryCategory =
  | "zh-short"
  | "code"
  | "english"
  | "mixed"
  | "punctuation"
  | "no-result"
  | "edge";

export type QueryPolicy =
  | "normal"
  | "no-result"
  | "empty"
  | "too-short"
  | "too-long"
  | "special"
  | "edge";

export interface GoldenQuerySpec {
  readonly id: string;
  readonly category: QueryCategory;
  readonly policy: QueryPolicy;
  readonly query: string;
  readonly expectedText: string | null;
  readonly expectedProjectKey: ProjectKey | null;
  readonly expectedEntityType: SearchEntityType | null;
}

export const GOLDEN_QUERY_VERSION = "phase4-v1";

type ExpectedTuple = readonly [
  query: string,
  expectedText: string,
  projectKey: ProjectKey,
  entityType: SearchEntityType,
];

function expectedCases(
  category: QueryCategory,
  entries: readonly ExpectedTuple[],
): Array<Omit<GoldenQuerySpec, "id">> {
  return entries.map(([query, expectedText, projectKey, entityType]) => ({
    category,
    policy: "normal" as const,
    query,
    expectedText,
    expectedProjectKey: projectKey,
    expectedEntityType: entityType,
  }));
}

function noResultCases(
  category: QueryCategory,
  entries: readonly string[],
  policy: QueryPolicy = "no-result",
): Array<Omit<GoldenQuerySpec, "id">> {
  return entries.map((query) => ({
    category,
    policy,
    query,
    expectedText: null,
    expectedProjectKey: null,
    expectedEntityType: null,
  }));
}

const zhShortCases: readonly ExpectedTuple[] = [
  ["登录", "登录模块重构与 Session 安全加固", "p1", "MODULE"],
  ["项目", "项目创建、成员与未分类模块", "p2", "PROJECT"],
  ["任务", "任务完成与迭代记录发布", "p3", "TASK"],
  ["搜索", "全局搜索投影和权限过滤", "p4", "MODULE"],
  ["发布", "迭代记录发布与版本保留", "p5", "CHANGE_RECORD"],
  ["合并", "任务合并为主任务与来源分支", "p6", "TASK_GROUP"],
  ["通知", "站内通知轮询与未读状态", "p1", "MODULE"],
  ["审计", "操作审计哈希链一致性", "p2", "MODULE"],
  ["概览", "项目概览统计与最近动态", "p3", "PROJECT"],
  ["动态", "项目动态时间线脱敏展示", "p4", "MODULE"],
  ["成员", "项目成员管理权限", "p5", "MODULE"],
  ["权限", "资源权限与 AuthorizedProjectScope", "p6", "MODULE"],
  ["模块", "模块管理和归档状态", "p1", "MODULE"],
  ["功能", "功能档案与影响范围", "p2", "MODULE"],
  ["记录", "迭代记录三段式内容", "p3", "CHANGE_RECORD"],
  ["遗留", "遗留问题转为任务", "p4", "TASK"],
  ["恢复", "作废迭代记录恢复", "p5", "CHANGE_RECORD"],
  ["作废", "迭代记录作废与可见性", "p6", "CHANGE_RECORD"],
  ["草稿", "迭代记录草稿编辑", "p1", "CHANGE_RECORD"],
  ["版本", "正式记录版本不可变", "p2", "CHANGE_RECORD"],
  ["续期", "订阅续期处理时限", "p1", "TASK"],
  ["熔断", "熔断降级兜底预置", "p2", "MODULE"],
  ["限流", "接口限流窗口设定", "p3", "MODULE"],
  ["快照", "快照保留周期说明", "p4", "CHANGE_RECORD"],
  ["沙箱", "沙箱环境重新搭建", "p5", "MODULE"],
  ["白名单", "白名单同步校验", "p6", "MODULE"],
  ["回执", "回执留存与签收", "p1", "TASK"],
  ["分派", "按紧急程度分派处理", "p2", "TASK"],
  ["验收", "验收要点逐条核对", "p3", "MODULE"],
  ["预热", "预热加载时长评估", "p4", "MODULE"],
  ["复盘", "现场复盘要点摘录", "p5", "CHANGE_RECORD"],
  ["切片", "纵向切片交付节奏", "p6", "MODULE"],
  ["配额", "存储配额调整说明", "p1", "PROJECT"],
  ["时区", "时区换算对照", "p2", "MODULE"],
  ["工单", "工单流转节点", "p3", "TASK"],
  ["台账", "台账登记口径", "p4", "CHANGE_RECORD"],
  ["预案", "预案切换步骤", "p5", "MODULE"],
  ["旁路", "旁路读取通道", "p6", "MODULE"],
  ["退避", "指数退避间隔", "p1", "MODULE"],
  ["截断", "截断阈值提示", "p2", "MODULE"],
  ["编排", "串并行编排顺序", "p3", "MODULE"],
  ["重放", "重放保护措施", "p4", "MODULE"],
];

const codeCases: readonly ExpectedTuple[] = [
  ["INP-T-2026-0001", "任务 INP-T-2026-0001 登录联调", "p1", "TASK"],
  ["PR-42", "Pull Request PR-42 权限修复", "p2", "EXTERNAL_LINK"],
  ["ISSUE-17", "Issue ISSUE-17 搜索召回问题", "p3", "EXTERNAL_LINK"],
  ["TASK-GROUP-009", "聚合组 TASK-GROUP-009 合并", "p4", "TASK_GROUP"],
  ["CR-2026-0031", "迭代记录 CR-2026-0031 发布", "p5", "CHANGE_RECORD"],
  ["PG-18-6", "PostgreSQL PG-18-6 基线", "p6", "PROJECT"],
  ["GIN-INDEX-001", "GIN-INDEX-001 trigram 索引验证", "p1", "MODULE"],
  ["MFA-REAUTH-05", "MFA-REAUTH-05 管理员重认证", "p2", "MODULE"],
  ["CSRF-ROTATE-02", "CSRF-ROTATE-02 Token 轮换", "p3", "MODULE"],
  ["SESSION-TOKEN-01", "SESSION-TOKEN-01 哈希存储", "p4", "MODULE"],
  ["API-V1-SEARCH", "API-V1-SEARCH 搜索接口", "p5", "MODULE"],
  ["PROJECT-ALPHA", "PROJECT-ALPHA 项目迁移", "p6", "PROJECT"],
  ["MODULE-CORE", "MODULE-CORE 核心模块", "p1", "MODULE"],
  ["FEATURE-LOGIN", "FEATURE-LOGIN 登录功能", "p2", "MODULE"],
  ["CHANGE-RECORD-V1", "CHANGE-RECORD-V1 首版记录", "p3", "CHANGE_RECORD"],
  ["LEFTOVER-0007", "LEFTOVER-0007 遗留项转任务", "p4", "TASK"],
  ["EXTERNAL-LINK-88", "EXTERNAL-LINK-88 GitHub 链接", "p5", "EXTERNAL_LINK"],
  ["RECOVERY-CODE-2026", "RECOVERY-CODE-2026 恢复码", "p6", "MODULE"],
  ["SEARCH-PROJECTION", "SEARCH-PROJECTION 投影写入", "p1", "MODULE"],
  ["NPM-11-19", "NPM-11-19 pnpm 基线", "p2", "PROJECT"],
  ["OPS-BACKUP-003", "OPS-BACKUP-003 冷备介质轮检", "p1", "TASK"],
  ["OPS-CACHE-014", "OPS-CACHE-014 热点桶容量巡检", "p2", "MODULE"],
  ["OPS-DRAIN-021", "OPS-DRAIN-021 排空窗口预约", "p3", "TASK"],
  ["OPS-FENCE-032", "OPS-FENCE-032 隔离栅栏部署", "p4", "MODULE"],
  ["OPS-GUARD-041", "OPS-GUARD-041 探针护栏配置", "p5", "MODULE"],
  ["OPS-JOURNAL-055", "OPS-JOURNAL-055 变更留痕附录", "p6", "CHANGE_RECORD"],
  ["OPS-KERNEL-066", "OPS-KERNEL-066 内核参数基线", "p1", "MODULE"],
  ["OPS-LEDGER-077", "OPS-LEDGER-077 账目勾稽口径", "p2", "CHANGE_RECORD"],
  ["OPS-MIRROR-088", "OPS-MIRROR-088 双活镜像比测", "p3", "MODULE"],
  ["OPS-NOMINAL-099", "OPS-NOMINAL-099 标称值复核", "p4", "MODULE"],
  ["OPS-PRIMER-121", "OPS-PRIMER-121 底漆工序约定", "p5", "TASK"],
  ["OPS-QUORUM-132", "OPS-QUORUM-132 表决节点拓扑", "p6", "MODULE"],
  ["OPS-RELAY-143", "OPS-RELAY-143 中继链路扩容", "p1", "MODULE"],
  ["OPS-SHIELD-154", "OPS-SHIELD-154 屏蔽罩安装", "p2", "TASK"],
  ["OPS-TRACE-165", "OPS-TRACE-165 样点追踪稽核", "p3", "MODULE"],
  ["OPS-UNBIND-176", "OPS-UNBIND-176 解绑复核清单", "p4", "TASK"],
  ["OPS-VALVE-187", "OPS-VALVE-187 阀门开度标定", "p5", "TASK"],
  ["OPS-WARDEN-198", "OPS-WARDEN-198 巡防岗位排班", "p6", "TASK"],
  ["OPS-YIELD-209", "OPS-YIELD-209 良率抽检结论", "p1", "CHANGE_RECORD"],
  ["OPS-ZONE-220", "OPS-ZONE-220 辖区划分图谱", "p2", "MODULE"],
  ["OPS-QUOTA-231", "OPS-QUOTA-231 令牌桶补发规则", "p3", "MODULE"],
  ["OPS-SEAL-242", "OPS-SEAL-242 铅封序列补录", "p4", "TASK"],
];

const englishCases: readonly ExpectedTuple[] = [
  ["login", "login session rotation and CSRF", "p1", "MODULE"],
  ["mfa", "mfa reauthentication and TOTP", "p2", "MODULE"],
  ["csrf", "csrf token issue and verify", "p3", "MODULE"],
  ["postgres", "postgres 18 transaction and roles", "p4", "PROJECT"],
  ["drizzle", "drizzle schema and migration", "p5", "MODULE"],
  ["session", "session token hash and expiry", "p6", "MODULE"],
  ["project", "project member access control", "p1", "PROJECT"],
  ["task", "task status history and assignment", "p2", "TASK"],
  ["search", "search projection query scope", "p3", "MODULE"],
  ["audit", "audit chain head lock", "p4", "MODULE"],
  ["notification", "notification recipient and cursor", "p5", "MODULE"],
  ["activity", "activity projection visibility", "p6", "MODULE"],
  ["permission", "permission matrix server check", "p1", "MODULE"],
  ["module", "module scope for task impact", "p2", "MODULE"],
  ["feature", "feature archive state", "p3", "MODULE"],
  ["change record", "change record version snapshot", "p4", "CHANGE_RECORD"],
  ["restore", "restore voided change record", "p5", "CHANGE_RECORD"],
  ["draft", "draft change record payload", "p6", "CHANGE_RECORD"],
  ["detach", "detach source task from group", "p1", "TASK_GROUP"],
  ["gin", "gin trigram index explain", "p2", "MODULE"],
  ["renewal", "renewal clock and grace period", "p1", "TASK"],
  ["breaker", "breaker ladder and fallback budget", "p2", "MODULE"],
  ["throttle", "throttle ceiling and burst bucket", "p3", "MODULE"],
  ["sandbox", "sandbox wiring and seed batch", "p4", "MODULE"],
  ["allowlist", "allowlist drift and owner confirm", "p5", "MODULE"],
  ["receipt", "receipt ledger and signing trail", "p6", "TASK"],
  ["dispatch", "dispatch rota and pager duty", "p1", "TASK"],
  ["rehearsal", "rehearsal script and cue sheet", "p2", "CHANGE_RECORD"],
  ["replay", "replay buffer and offset guard", "p3", "MODULE"],
  ["retention", "retention shelf and purge cadence", "p4", "MODULE"],
  ["watermark", "watermark gauge and settle cut", "p5", "MODULE"],
  ["sharding", "sharding key and routing map", "p6", "MODULE"],
  ["parity", "parity probe and drift report", "p1", "MODULE"],
  ["attest", "attest note and witness stamp", "p2", "CHANGE_RECORD"],
  ["enroll", "enroll token and binding step", "p3", "MODULE"],
  ["subset", "subset export and schema note", "p4", "MODULE"],
  ["uplift", "uplift curve and ceiling note", "p5", "MODULE"],
  ["freeze", "freeze window and thaw plan", "p6", "MODULE"],
  ["warrant", "warrant stamp and archive copy", "p1", "CHANGE_RECORD"],
  ["quarantine", "quarantine zone and escort log", "p2", "MODULE"],
  ["safeguard", "safeguard latch and seal log", "p3", "MODULE"],
  ["handover", "handover sheet and shift log", "p4", "TASK"],
];

const mixedCases: readonly ExpectedTuple[] = [
  ["登录2026", "登录2026 功能重构", "p1", "MODULE"],
  ["PR-42 权限修复", "PR-42 权限修复合入", "p2", "EXTERNAL_LINK"],
  ["项目ALPHA", "项目ALPHA 成员迁移", "p3", "PROJECT"],
  ["搜索“全局”", "搜索“全局”跨项目范围", "p4", "MODULE"],
  ["任务TASK-100", "任务TASK-100 指派变更", "p5", "TASK"],
  ["完成迭代记录v2", "完成迭代记录v2 并发布", "p6", "CHANGE_RECORD"],
  ["MFA重认证-05", "MFA重认证-05 管理员操作", "p1", "MODULE"],
  ["CSRF轮换", "CSRF轮换会话保护", "p2", "MODULE"],
  ["PostgreSQL18迁移", "PostgreSQL18迁移与角色", "p3", "PROJECT"],
  ["合并TASK-GROUP-009", "合并TASK-GROUP-009来源分支", "p4", "TASK_GROUP"],
  ["通知-未读", "通知-未读计数与轮询", "p5", "MODULE"],
  ["动态“项目概览”", "动态“项目概览”时间线", "p6", "MODULE"],
  ["审计-100并发", "审计-100并发链一致", "p1", "MODULE"],
  ["模块CORE", "模块CORE 功能影响", "p2", "MODULE"],
  ["功能-LOGIN", "功能-LOGIN 登录档案", "p3", "MODULE"],
  ["记录CR-2026-0031", "记录CR-2026-0031版本", "p4", "CHANGE_RECORD"],
  ["遗留问题-0007", "遗留问题-0007转任务", "p5", "TASK"],
  ["恢复-作废记录", "恢复-作废记录状态", "p6", "CHANGE_RECORD"],
  ["草稿-版本2", "草稿-版本2内容保存", "p1", "CHANGE_RECORD"],
  ["GitHub-PR-42", "GitHub-PR-42链接", "p2", "EXTERNAL_LINK"],
  ["AGENT-值守", "AGENT-值守排班复核", "p1", "TASK"],
  ["ALERT-抑制", "ALERT-抑制窗口校对", "p2", "MODULE"],
  ["BATCH-拆分", "BATCH-拆分口径说明", "p3", "MODULE"],
  ["CAPACITY-预估", "CAPACITY-预估口径说明", "p4", "MODULE"],
  ["DELAY-波动", "DELAY-波动区间标注", "p5", "MODULE"],
  ["ESCALATE-升级", "ESCALATE-升级路径核对", "p6", "MODULE"],
  ["FALLBACK-回落", "FALLBACK-回落条件核对", "p1", "MODULE"],
  ["GRID-网格", "GRID-网格划分核对", "p2", "MODULE"],
  ["HASHBAND-哈希序", "HASHBAND-哈希序校验", "p3", "MODULE"],
  ["INDEXSHIFT-漂移", "INDEXSHIFT-漂移观测", "p4", "MODULE"],
  ["JITTER-抖动", "JITTER-抖动域统计", "p5", "MODULE"],
  ["KEEPLIVE-保活", "KEEPLIVE-保活脉冲设定", "p6", "MODULE"],
  ["LEASE-租约", "LEASE-租约续签核对", "p1", "MODULE"],
  ["MUTEX-互斥", "MUTEX-互斥区标注", "p2", "MODULE"],
  ["NODEZONE-分区", "NODEZONE-分区归属标注", "p3", "MODULE"],
  ["OFFSET-偏移", "OFFSET-偏移量核查", "p4", "MODULE"],
  ["PROBE-探针", "PROBE-探针阈值标定", "p5", "MODULE"],
  ["RATIO-配比", "RATIO-配比方案核对", "p6", "MODULE"],
  ["SNAPSHOT-镜像", "SNAPSHOT-镜像标注", "p1", "MODULE"],
  ["TICKET-票据", "TICKET-票据流转标注", "p2", "MODULE"],
  ["VOUCHER-凭据", "VOUCHER-凭据核销标注", "p3", "TASK"],
  ["WINDOWEDGE-边界", "WINDOWEDGE-边界样本标注", "p4", "MODULE"],
];

const punctuationCases: readonly ExpectedTuple[] = [
  ["登录，版本", "登录，版本管理与发布校验", "p1", "CHANGE_RECORD"],
  ["全局搜索：", "全局搜索：项目范围筛选", "p2", "MODULE"],
  ["项目（POC）", "项目（POC）命名与编号", "p3", "PROJECT"],
  ["任务/记录", "任务/记录关联关系", "p4", "TASK"],
  ["MFA+CSRF", "MFA+CSRF 重认证流程", "p5", "MODULE"],
  ["未读·通知", "未读·通知计数", "p6", "MODULE"],
  ["审计；100并发", "审计；100并发链一致", "p1", "MODULE"],
  ["恢复——记录", "恢复——记录状态与历史", "p2", "CHANGE_RECORD"],
  ["作废「记录」", "作废「记录」可见性", "p3", "CHANGE_RECORD"],
  ["GitHub_Issue#42", "GitHub_Issue#42 链接审批", "p4", "EXTERNAL_LINK"],
  ["备份（双份）", "备份（双份）留存说明", "p1", "CHANGE_RECORD"],
  ["巡检/复检", "巡检/复检周期标注", "p2", "MODULE"],
  ["限额：双线", "限额：双线切换说明", "p3", "MODULE"],
  ["闸门；开度", "闸门；开度标尺说明", "p4", "MODULE"],
  ["口径·换算", "口径·换算对照表", "p5", "MODULE"],
  ["复核；双签", "复核；双签要点", "p6", "CHANGE_RECORD"],
  ["令牌（短期）", "令牌（短期）回收说明", "p1", "MODULE"],
  ["凭证「存根」", "凭证「存根」留存", "p2", "CHANGE_RECORD"],
  ["灰度·探针", "灰度·探针读数", "p3", "MODULE"],
  ["采样（抽点）", "采样（抽点）比例说明", "p4", "MODULE"],
  ["对照「基线」", "对照「基线」偏差说明", "p5", "MODULE"],
  ["签收——封样", "签收——封样说明", "p6", "TASK"],
];

const noResultQueries = [
  "qx7-不存在-zz9",
  "不存在词条xq7",
  "%%",
  "__",
  "\\\\",
  '<>?&"{}',
  "新词不存在-2026",
];

const edgeCases = [
  ...noResultCases("no-result", noResultQueries),
  ...noResultCases("edge", ["a"], "too-short"),
  ...noResultCases("edge", [""], "empty"),
  ...noResultCases("edge", ["x".repeat(300)], "too-long"),
];

const goldenInputs: ReadonlyArray<Omit<GoldenQuerySpec, "id">> = [
  ...expectedCases("zh-short", zhShortCases),
  ...expectedCases("code", codeCases),
  ...expectedCases("english", englishCases),
  ...expectedCases("mixed", mixedCases),
  ...expectedCases("punctuation", punctuationCases),
  ...edgeCases,
];

export const goldenQueries: readonly GoldenQuerySpec[] = goldenInputs.map(
  (entry, index) => ({
    ...entry,
    id: `G${String(index + 1).padStart(3, "0")}`,
  }),
);

export function assertGoldenQueryShape(): number {
  if (goldenQueries.length !== 200) {
    throw new Error(
      `Golden query count must be 200, got ${goldenQueries.length}`,
    );
  }

  const ids = new Set<string>();
  for (const [index, entry] of goldenQueries.entries()) {
    const expectedId = `G${String(index + 1).padStart(3, "0")}`;
    if (entry.id !== expectedId || ids.has(entry.id)) {
      throw new Error(`Golden query id mismatch or duplicate: ${entry.id}`);
    }
    ids.add(entry.id);

    if (entry.policy === "normal" && entry.expectedText === null) {
      throw new Error(`${entry.id} must define expected text`);
    }
    if (entry.policy !== "normal" && entry.expectedText !== null) {
      throw new Error(`${entry.id} must not define expected text`);
    }
  }

  const normalCases = goldenQueries.filter(
    (entry) => entry.policy === "normal",
  ).length;
  if (normalCases < 180) {
    throw new Error(`Need at least 180 expected cases, got ${normalCases}`);
  }

  return normalCases;
}
