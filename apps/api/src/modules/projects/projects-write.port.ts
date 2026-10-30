import type { ProjectStatus } from "@inpulse/api-contract";

import type { TransactionContext } from "../../database/transaction-context.js";

/**
 * ADR-043 项目生命周期三态：未开始 / 进行中 / 维护中。
 * 新建项目固定从未开始起步，项目层不再有归档目标态。
 */
export type ProjectLifecycleStatus = ProjectStatus;

/** 项目创建输入；创建者由调用方（Workflow）从认证 Session 解析并显式传入。 */
export interface CreateProjectRecordInput {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly createdBy: number;
}

export interface ProjectCreatedRecord {
  readonly projectId: number;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly createdBy: number;
  readonly status: "NOT_STARTED";
  readonly rowVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AddProjectMemberInput {
  readonly projectId: number;
  readonly userId: number;
  /** ADR-033：缺省 MEMBER；创建项目 Workflow 对创建者显式传 LEADER。 */
  readonly role?: "MEMBER" | "LEADER";
}

export interface ProjectMemberAddedRecord {
  readonly userId: number;
  readonly status: "ACTIVE" | "REMOVED";
  readonly role: "MEMBER" | "LEADER";
  readonly joinedAt: string;
}

/** 成员管理完整历史记录；名称与头像仅用于管理员展示与成员列表，不包含账号敏感字段。 */
export interface ProjectMemberRecord {
  readonly membershipId: number;
  readonly projectId: number;
  readonly userId: number;
  readonly name: string;
  readonly avatarUrl: string | null;
  readonly status: "ACTIVE" | "REMOVED";
  /** ADR-033：项目内角色；REMOVED 行恒为 MEMBER。 */
  readonly role: "MEMBER" | "LEADER";
  readonly joinedAt: string;
  readonly removedAt: string | null;
}

export interface ProjectMemberIdentity {
  readonly projectId: number;
  readonly userId: number;
}

/** 项目存在性/只读摘要；供事务内成员管理命令验证目标项目。 */
export interface ProjectRecord {
  readonly projectId: number;
  readonly name: string;
  readonly status: ProjectLifecycleStatus;
  readonly rowVersion: number;
}

/** 项目变更后的完整公开摘要；与 ProjectItem 对齐，供写操作直接构造响应。 */
export interface ProjectChangeRecord {
  readonly projectId: number;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly status: ProjectLifecycleStatus;
  /**
   * 粘性标记：项目第一次有任务完成的时间；有值即表示项目已有产出，
   * 服务端禁止把它回退为未开始。
   */
  readonly firstTaskCompletedAt: string | null;
  readonly rowVersion: number;
  readonly createdBy: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly memberCount: number;
  readonly stats: ProjectStatRecord;
}

/**
 * 任务完成后的粘性置位结果；调用方据此判定是否需要写审计、活动与站内通知。
 * previousStatus 非未开始或 status 未变时表示只是补齐标记，无需额外副作用。
 */
export interface ProjectFirstTaskCompletionRecord {
  readonly projectId: number;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly previousStatus: ProjectLifecycleStatus;
  readonly status: ProjectLifecycleStatus;
  readonly rowVersion: number;
  readonly firstTaskCompletedAt: string;
}

/**
 * 任务重新变为未收尾（创建、重新打开或恢复）把维护中项目重新打开为进行中的结果；
 * 调用方据此判定是否需要写审计、活动与搜索投影。返回 undefined 表示本次操作不改变
 * 项目状态（项目不是维护中或不存在），不产生任何副作用。
 */
export interface ProjectMaintenanceReopenRecord {
  readonly projectId: number;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly status: "ACTIVE";
  readonly rowVersion: number;
}

/** 项目卡统计；与 R-2 项目概览的 ProjectOverviewStats 同名同口径。 */
export interface ProjectStatRecord {
  readonly activeModuleCount: number;
  readonly openTaskCount: number;
  readonly completedTaskCount: number;
}

/** 项目封箱海报数据版本；桥接必须拒绝未知版本而不是猜测字段。 */
export const PROJECT_WRAP_TEMPLATE_VERSION = 2;

export interface ProjectWrapParticipant {
  readonly userId: number;
  readonly name: string;
  readonly role: "MEMBER" | "LEADER";
  readonly completedTaskCount: number;
}

/** 封箱时冻结的统计、参与者与时间线；不随项目后续变化而更新。 */
export interface ProjectWrapSnapshot {
  readonly version: typeof PROJECT_WRAP_TEMPLATE_VERSION;
  readonly project: {
    readonly id: number;
    readonly code: string;
    readonly name: string;
  };
  readonly stats: {
    readonly completedTaskCount: number;
    readonly publishedRecordCount: number;
    readonly activeMemberCount: number;
    readonly activeModuleCount: number;
    readonly openTaskCount: number;
    readonly durationDays: number;
    readonly completionPercent: number;
  };
  readonly participants: readonly ProjectWrapParticipant[];
  readonly timeline: {
    readonly foundedAt: string;
    readonly firstRecordAt: string | null;
    readonly lastTaskCompletedAt: string;
    readonly sealedAt: string;
  };
}

export interface ProjectWrapRecord {
  readonly projectId: number;
  readonly sealedAt: string;
  readonly templateVersion: number;
  readonly snapshot: ProjectWrapSnapshot;
}

/** 物理删除实际删除的业务行数与保留的审计行数；只用于审计留痕，不参与幂等摘要。 */
export interface ProjectPurgeCounts {
  readonly modules: number;
  readonly tasks: number;
  readonly changeRecords: number;
  readonly retainedAuditLogs: number;
  readonly members: number;
  readonly total: number;
}

/** 项目与成员写边界；只做持久化，不决定业务状态流转，调用方持有事务。 */
export abstract class ProjectsWritePort {
  abstract createProject(
    tx: TransactionContext,
    input: CreateProjectRecordInput,
  ): Promise<ProjectCreatedRecord>;

  abstract addMember(
    tx: TransactionContext,
    input: AddProjectMemberInput,
  ): Promise<ProjectMemberAddedRecord>;

  abstract listMembers(
    tx: TransactionContext,
    input: { readonly projectId: number },
  ): Promise<ProjectMemberRecord[]>;

  abstract findLatestMember(
    tx: TransactionContext,
    input: ProjectMemberIdentity,
    lock?: boolean,
  ): Promise<ProjectMemberRecord | undefined>;

  abstract findProject(
    tx: TransactionContext,
    input: { readonly projectId: number },
  ): Promise<ProjectRecord | undefined>;

  /** 读取项目完整摘要；lock 为 true 时对项目行 FOR UPDATE。 */
  abstract findProjectForChange(
    tx: TransactionContext,
    input: { readonly projectId: number },
    lock?: boolean,
  ): Promise<ProjectChangeRecord | undefined>;

  /** 条件更新名称与描述并递增 row_version；版本不匹配返回 undefined。 */
  abstract updateProjectDetails(
    tx: TransactionContext,
    input: {
      readonly projectId: number;
      readonly expectedRowVersion: number;
      readonly name: string;
      readonly description: string;
    },
  ): Promise<ProjectChangeRecord | undefined>;

  /**
   * 条件迁移项目状态并保持 row_version（ADR-092）；内容版本不匹配返回 undefined。
   * ADR-043：项目状态只有三态，archived_at 是归档时代的只读历史列，不再写入。
   */
  abstract updateProjectStatus(
    tx: TransactionContext,
    input: {
      readonly projectId: number;
      readonly expectedRowVersion: number;
      readonly status: ProjectLifecycleStatus;
    },
  ): Promise<ProjectChangeRecord | undefined>;

  /**
   * ADR-091：项目第一次进入维护中且至少有一个已完成任务时冻结封箱快照。
   * 表主键保证每个项目终生至多一次；已有快照、没有完成任务或项目不存在时返回
   * undefined，不产生任何副作用。
   */
  abstract createProjectWrap(
    tx: TransactionContext,
    input: {
      readonly projectId: number;
      readonly actorId: number;
      readonly sealedAt: Date;
    },
  ): Promise<ProjectWrapRecord | undefined>;

  /**
   * ADR-062 / ADR-085：调用 `app.purge_project` 物理删除项目及其全部下级
   * 业务数据，但保留 `PROJECT:<id>` 审计日志与链头；返回实际删除行数和保留的
   * 审计行数。项目行不存在或已被并发删除时数据库抛错；调用方必须先在同一事务
   * 内锁定并校验项目行。
   */
  abstract purgeProject(
    tx: TransactionContext,
    input: { readonly projectId: number },
  ): Promise<ProjectPurgeCounts>;

  /**
   * 任务完成写路径的粘性置位：first_task_completed_at 取最早一次完成时间且永不回落；
   * 项目当前处于未开始时在同一语句内升级为进行中并递增 row_version。
   *
   * 项目不存在、或已有粘性标记且不再是未开始（本次无需任何变更）都返回 undefined，
   * 由调用方按「没有状态迁移」处理；这也让后续任务完成不会反复推高项目版本。
   */
  abstract recordFirstTaskCompletion(
    tx: TransactionContext,
    input: { readonly projectId: number; readonly completedAt: Date },
  ): Promise<ProjectFirstTaskCompletionRecord | undefined>;

  /**
   * ADR-056 / ADR-057：任务重新变为未收尾（新建、重新打开或恢复）后维护中项目
   * 重新开工——维护中的语义是「主体已完成、只做小修小补」，一旦有未收尾任务
   * 进来就不再成立，同一事务内回到进行中。
   * 只命中 status = 'MAINTENANCE' 的行并保持 row_version（ADR-092）；未开始与进行中项目
   * 不命中任何行，因此重复调用不会推高项目版本。
   */
  abstract reopenMaintenanceProject(
    tx: TransactionContext,
    input: { readonly projectId: number },
  ): Promise<ProjectMaintenanceReopenRecord | undefined>;

  /**
   * 统计项目下尚未收尾的任务数（lifecycle_status 为 ACTIVE 且工作状态既非 DONE
   * 也非 CANCELED）；ADR-043：项目进入维护中要求结果为 0。
   * 命名从 countUnarchivedTasks 改为 countOpenTasks（ADR-054）：任务归档已下线，
   * 「未归档」不再是一个可表述的概念，SQL 口径不变。
   */
  abstract countOpenTasks(
    tx: TransactionContext,
    input: { readonly projectId: number },
  ): Promise<number>;

  /** 重新加入/新增 ACTIVE 成员；调用方须先锁定历史并处理活跃冲突。 */
  abstract addMemberHistory(
    tx: TransactionContext,
    input: AddProjectMemberInput,
  ): Promise<ProjectMemberRecord>;

  abstract removeMember(
    tx: TransactionContext,
    input: ProjectMemberIdentity,
  ): Promise<ProjectMemberRecord | undefined>;

  /**
   * ADR-033：条件更新 ACTIVE 成员行角色；目标非 ACTIVE 或不存在返回 undefined。
   * LEADER 唯一性由部分唯一索引保证，冲突由调用方映射 409。
   */
  abstract setMemberRole(
    tx: TransactionContext,
    input: ProjectMemberIdentity & {
      readonly role: "MEMBER" | "LEADER";
    },
  ): Promise<ProjectMemberRecord | undefined>;
}

/** 文档成员/负责人令牌解析结果；token 为文档中的原始令牌，按规范化登录名或姓名匹配。 */
export type ActiveUserTokenResolution =
  | {
      readonly token: string;
      readonly kind: "resolved";
      readonly userId: number;
      readonly name: string;
    }
  | { readonly token: string; readonly kind: "not-found" }
  | { readonly token: string; readonly kind: "ambiguous" };

/** 项目成员 ACTIVE 校验；返回合法集合，调用方负责与请求成员比对并决定是否回滚。 */
export abstract class ActiveUsersQueryPort {
  abstract findActiveUserIds(
    tx: TransactionContext,
    userIds: readonly number[],
  ): Promise<readonly number[]>;

  /**
   * ADR-064：解析固定模板文档中的负责人/项目成员令牌。匹配顺序固定为
   * 规范化登录名（全局唯一）优先、规范化姓名其次；姓名命中多个用户视为歧义。
   * 只解析 ACTIVE 且未停用用户；调用方传入已 trim + 小写化的令牌。
   */
  abstract resolveActiveUsersByTokens(
    tx: TransactionContext,
    normalizedTokens: readonly string[],
  ): Promise<readonly ActiveUserTokenResolution[]>;
}
