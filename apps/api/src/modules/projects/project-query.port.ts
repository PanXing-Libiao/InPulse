import type {
  ProjectItem,
  ProjectListItem,
  ProjectStatus,
} from "@inpulse/api-contract";

/** 项目生命周期状态的轻读结果；只带判定字段，不含统计列。 */
export interface ProjectStatusRef {
  readonly projectId: number;
  readonly status: ProjectStatus;
}

/** 项目只读查询 Port；调用方先通过 AuthorizedProjectScope 限制项目范围。 */
export abstract class ProjectQueryPort {
  /**
   * 项目列表；提供 actorUserId 时附带该用户在本项目的成员角色与待审归档
   * 申请摘要（ADR-034），供列表页决定「申请归档」与审核入口。
   */
  abstract list(
    projectIds: readonly number[],
    actorUserId?: number,
  ): Promise<readonly ProjectListItem[]>;

  /**
   * 按 ID 批量读取当前生命周期状态（ADR-043 三态）。任务中心的展示口径要在
   * 下游列表与统计之前剔除维护中项目，因此这里刻意只查 id 与 status：
   * 统计列（模块 / 任务计数）在该路径上没有消费者，不重复计算。
   * 同样不校验授权（由 AuthorizedProjectScope 决定范围），未知 ID 不返回。
   */
  abstract listStatuses(
    projectIds: readonly number[],
  ): Promise<readonly ProjectStatusRef[]>;

  abstract find(projectId: number): Promise<ProjectItem | undefined>;

  /** ADR-033：当前用户在本项目的 ACTIVE 成员角色；非成员返回 null。 */
  abstract findActiveMemberRole(
    projectId: number,
    userId: number,
  ): Promise<"MEMBER" | "LEADER" | null>;
}
