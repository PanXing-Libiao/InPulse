import {
  goldenQueries,
  type ProjectKey,
  type SearchEntityType,
} from "./golden-queries.js";
import { normalizeSearchText } from "./normalize.js";

export const PROJECT_KEYS: readonly ProjectKey[] = [
  "p1",
  "p2",
  "p3",
  "p4",
  "p5",
  "p6",
];

export interface ProjectDefinition {
  readonly key: ProjectKey;
  readonly codePrefix: string;
  readonly name: string;
}

export const PROJECT_DEFINITIONS: readonly ProjectDefinition[] = [
  { key: "p1", codePrefix: "POCC1", name: "InPulse 项目一号" },
  { key: "p2", codePrefix: "POCC2", name: "InPulse 项目二号" },
  { key: "p3", codePrefix: "POCC3", name: "InPulse 项目三号" },
  { key: "p4", codePrefix: "POCC4", name: "InPulse 项目四号" },
  { key: "p5", codePrefix: "POCC5", name: "InPulse 项目五号" },
  { key: "p6", codePrefix: "POCC6", name: "InPulse 项目六号" },
];

export interface SearchRowSeed {
  readonly projectKey: ProjectKey;
  readonly entityType: SearchEntityType;
  readonly entityId: number;
  readonly title: string;
  readonly summary: string;
  readonly rawText: string;
  readonly normalizedSearchText: string;
}

export interface SearchSeedResult {
  readonly rows: readonly SearchRowSeed[];
  readonly expectedEntityIdsByGoldenId: ReadonlyMap<string, number>;
  readonly expectedEntityTypesByGoldenId: ReadonlyMap<string, SearchEntityType>;
}

const distractorTemplates: ReadonlyArray<{
  readonly title: string;
  readonly summary: string;
  readonly entityType: SearchEntityType;
}> = [
  {
    title: "网关超时重试",
    summary: "链路质量与稳定性验证",
    entityType: "TASK",
  },
  {
    title: "缓存失效排查",
    summary: "热点访问与命中率观察",
    entityType: "TASK",
  },
  { title: "批量导入对账", summary: "数据量级与差异核对", entityType: "TASK" },
  {
    title: "压测报告归档",
    summary: "结果留档与趋势对比",
    entityType: "CHANGE_RECORD",
  },
  { title: "链路追踪采样", summary: "跨服务调用链采样", entityType: "MODULE" },
  {
    title: "索引优化演练",
    summary: "查询计划与缓冲区观察",
    entityType: "MODULE",
  },
  {
    title: "容器资源水位",
    summary: "运行实例与资源上限观察",
    entityType: "MODULE",
  },
  {
    title: "告警收敛策略",
    summary: "通知频率与抑制窗口",
    entityType: "MODULE",
  },
  {
    title: "接口幂等补偿",
    summary: "重复请求与补偿流程",
    entityType: "MODULE",
  },
  {
    title: "配置中心回滚",
    summary: "配置变更与快速回落",
    entityType: "MODULE",
  },
  {
    title: "备份窗口调度",
    summary: "窗口容量与执行时长",
    entityType: "MODULE",
  },
  { title: "迁移前检查", summary: "结构差异与历史一致性", entityType: "TASK" },
  { title: "票据队列吞吐", summary: "队列长度与消费速率", entityType: "TASK" },
  {
    title: "灰度指标看板",
    summary: "分组对比与异常阈值",
    entityType: "MODULE",
  },
  {
    title: "代码扫描门禁",
    summary: "扫描结果与阻断规则",
    entityType: "MODULE",
  },
  {
    title: "构建缓存复用",
    summary: "增量构建与缓存命中",
    entityType: "MODULE",
  },
  { title: "证书轮换提醒", summary: "有效期与提醒窗口", entityType: "MODULE" },
  {
    title: "密钥轮换提醒",
    summary: "轮换窗口与合规检查",
    entityType: "MODULE",
  },
  {
    title: "调用链耗时统计",
    summary: "分段耗时与峰值观察",
    entityType: "MODULE",
  },
  {
    title: "巡检报告汇总",
    summary: "检查项与风险汇总",
    entityType: "CHANGE_RECORD",
  },
];

function projectKeyAt(index: number): ProjectKey {
  const key = PROJECT_KEYS[index % PROJECT_KEYS.length];
  if (key === undefined) {
    throw new Error("Search seed project key is undefined");
  }
  return key;
}

function templateAt(index: number): (typeof distractorTemplates)[number] {
  const template = distractorTemplates[index % distractorTemplates.length];
  if (template === undefined) {
    throw new Error("Search seed template is undefined");
  }
  return template;
}

function buildSearchRow(
  projectKey: ProjectKey,
  entityType: SearchEntityType,
  entityId: number,
  title: string,
  summary: string,
): SearchRowSeed {
  const rawText = `${title}。${summary}。阶段0仿真数据。`;
  return {
    projectKey,
    entityType,
    entityId,
    title,
    summary,
    rawText,
    normalizedSearchText: normalizeSearchText(rawText),
  };
}

export function buildSearchSeed(): SearchSeedResult {
  const rows: SearchRowSeed[] = [];
  const expectedEntityIdsByGoldenId = new Map<string, number>();
  const expectedEntityTypesByGoldenId = new Map<string, SearchEntityType>();

  for (const [index, entry] of goldenQueries.entries()) {
    if (entry.policy !== "normal") {
      continue;
    }
    const projectKey = entry.expectedProjectKey;
    const entityType = entry.expectedEntityType;
    const expectedText = entry.expectedText;
    if (projectKey === null || entityType === null || expectedText === null) {
      throw new Error(`${entry.id} is missing an expected fixture`);
    }

    const entityId = index + 1;
    rows.push(
      buildSearchRow(
        projectKey,
        entityType,
        entityId,
        expectedText,
        "金标目标，仅用于验证召回与范围过滤",
      ),
    );
    expectedEntityIdsByGoldenId.set(entry.id, entityId);
    expectedEntityTypesByGoldenId.set(entry.id, entityType);
  }

  const requiredRows = 1000;
  const expectedCount = rows.length;
  for (let offset = 0; offset < requiredRows - expectedCount; offset += 1) {
    const entityId = expectedCount + offset + 1;
    const projectKey = projectKeyAt(offset);
    const template = templateAt(offset);
    const project = PROJECT_DEFINITIONS.find(
      (definition) => definition.key === projectKey,
    );
    if (project === undefined) {
      throw new Error(`Missing project definition for ${projectKey}`);
    }
    const title = `${template.title}-${String(entityId).padStart(4, "0")}`;
    const summary = `${template.summary}，编号 ${project.codePrefix}-${String(entityId).padStart(4, "0")}`;
    rows.push(
      buildSearchRow(projectKey, template.entityType, entityId, title, summary),
    );
  }

  return {
    rows,
    expectedEntityIdsByGoldenId,
    expectedEntityTypesByGoldenId,
  };
}
