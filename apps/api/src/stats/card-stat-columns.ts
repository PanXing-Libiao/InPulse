import type { ISql } from "postgres";

/**
 * 卡片统计列：项目卡、模块卡与 R-2 项目概览共用同一份口径，
 * 避免各读取端口分别拼 SQL 造成同一指标在不同页面数字不一致。
 *
 * - `openTaskCount`：`work_status = 'TODO'` 且 `lifecycle_status <> 'INVALID'`，
 *   并排除仍挂在活跃聚合组下的历史来源分支（合并后不再计入待办，
 *   与任务查询的 effectiveOnly 一致）。
 * - `completedTaskCount`：同一「有效任务」口径下 `work_status = 'DONE'` 的任务数；
 *   模块卡用它判定「未开始」标签（作用域内没有已完成任务即未开始），
 *   项目标签自 ADR-035 起改读存储状态，不再由该计数推导。
 * - `activeModuleCount`：项目内 `status = 'ACTIVE'` 的未删除模块数。
 *
 * 外层行别名由 postgres.js 标识符转义注入，不接受任意字符串；参数取 `ISql`，
 * 使读取端的 `Sql` 与事务内的 `TransactionSql` 都可复用。
 */
export type CardRowAlias = "p" | "u" | "m";

/** 统计「哪一层的待办任务」：项目卡按项目、模块卡按模块。 */
export type TaskScope = "project" | "module";

/**
 * 推导式生命周期排序键适用的作用域：模块仍是「作用域内有没有已完成任务」
 * 推导出来的未开始 / 进行中；项目自 ADR-035 起改为读存储状态，走下面的
 * `projectTierRankExpression`。
 */
export type DerivedLifecycleScope = Exclude<TaskScope, "project">;

/** 外层行主键：走 postgres.js 的标识符转义，不能改写为参数占位符。 */
const rowId = (sql: ISql, table: CardRowAlias) => sql(`${table}.id`);

/** 待办任务的归属条件：项目卡按项目、模块卡按模块。 */
const taskScopeWhere = (sql: ISql, scope: TaskScope, table: CardRowAlias) => {
  const id = rowId(sql, table);
  return scope === "project"
    ? sql`t.project_id = ${id}`
    : sql`t.module_id = ${id}`;
};

/**
 * 「有效任务」条件：排除已作废任务，以及仍挂在活跃聚合组下的历史来源分支。
 * `openTaskCount` 与 `completedTaskCount` 共用，保证两个指标同一口径。
 */
const effectiveTaskWhere = (sql: ISql) => sql`t.deleted_at IS NULL
              AND t.lifecycle_status <> 'INVALID'
              AND NOT EXISTS (
                SELECT 1
                  FROM app.task_group_members gm
                  JOIN app.task_groups g
                    ON g.id = gm.group_id
                   AND g.project_id = gm.project_id
                 WHERE gm.task_id = t.id
                   AND g.status = 'ACTIVE'
                   AND gm.status = 'ACTIVE'
                   AND gm.role = 'SOURCE'
                   AND gm.source_kind = 'HISTORICAL'
              )`;

const openTaskCountColumn = (
  sql: ISql,
  scope: TaskScope,
  table: CardRowAlias,
) => sql`(
           SELECT COUNT(*)::integer
             FROM app.tasks t
            WHERE ${taskScopeWhere(sql, scope, table)}
              AND t.work_status = 'TODO'
              AND ${effectiveTaskWhere(sql)}
         ) AS "openTaskCount"`;

/** 已完成任务数：同一「有效任务」口径下的 `work_status = 'DONE'` 计数。 */
const completedTaskCountColumn = (
  sql: ISql,
  scope: TaskScope,
  table: CardRowAlias,
) => sql`(
           SELECT COUNT(*)::integer
             FROM app.tasks t
            WHERE ${taskScopeWhere(sql, scope, table)}
              AND t.work_status = 'DONE'
              AND ${effectiveTaskWhere(sql)}
         ) AS "completedTaskCount"`;

/**
 * 项目列表排序键（ADR-063，修订 ADR-046 决策 1 的项目行）：只分「未完成 / 维护中」两档——
 * 0 = 未完成（进行中 `ACTIVE` 与未开始 `NOT_STARTED` 同属一档）、1 = 维护中；`ELSE 2` 只兜底
 * 未知脏值，排在最后。
 *
 * 2026-10-09 用户指示：「在项目未完成状态下，每次当项目中有更新，则将项目排序排到最前面」。
 * 因此未完成档内不再先按进行中 → 未开始分档，统一由 `projectLastChangeExpression` 从近到远排
 * （最近有业务变更的项目排最前），时间相同时按创建时间、ID 降序兜底；追加键由调用方
 * `postgres-project-query-port.ts` 的 `list` 写在 `ORDER BY` 里，本函数只产出档位这一列。
 *
 * 前端 `apps/web/src/features/common/resource-lifecycle.ts` 的 `projectTier` 按同一归并
 * 渲染「未完成 / 维护中」两档；项目标签本身仍按三态渲染（进行中 / 未开始 / 维护中），标签与
 * 分档都要跟着本函数修改。
 */
export function projectTierRankExpression(sql: ISql, table: "p" | "u") {
  return sql`CASE ${sql(`${table}.status`)}
             WHEN 'ACTIVE' THEN 0
             WHEN 'NOT_STARTED' THEN 0
             WHEN 'MAINTENANCE' THEN 1
             ELSE 2
           END`;
}

/**
 * 项目「最近变更时间」（ADR-046 2026-10-08 修订）：该项目动态投影里最新一条业务
 * 事件的发生时间，没有动态的项目回落创建时间。生成任务、完成任务、状态流转、
 * 发布 / 作废记录、成员变化等业务写入都会在同一事务里写项目动态，因此它比
 * `projects.updated_at` / `row_version`（只随项目自身行改动）更贴近「最近有变更」。
 *
 * 逐项目 MAX 走 `activity_projection_project_cursor_idx (project_id, occurred_at, id)`
 * 的反向索引扫描，不需要新增索引；`WHERE` 仍由授权范围的项目集合驱动。
 */
export function projectLastChangeExpression(sql: ISql, table: "p" | "u") {
  return sql`COALESCE(
             (
               SELECT MAX(a.occurred_at)
                 FROM app.activity_projection a
                WHERE a.project_id = ${sql(`${table}.id`)}
             ),
             ${sql(`${table}.created_at`)}
           )`;
}

/**
 * 模块的推导式生命周期排序键：0 = 进行中（作用域内已有完成任务）、
 * 1 = 未开始（作用域内尚无完成任务）。前端
 * `apps/web/src/features/common/resource-lifecycle.ts` 按同一规则渲染标签，
 * 两处必须一起修改。
 *
 * ADR-044 起模块只有 `ACTIVE` 一种状态，因此派生档位只剩
 * 0 = 进行中、1 = 未开始两档，不再有 2 = 已归档。
 *
 * 档位相同的卡片再按「创建时间从近到远」排，同创建时间时按 ID 降序兜底；模块侧自
 * 2026-09-24 起不再使用 `sort_order` 作为排序键（该列应用内从不写入、恒为默认值 0，
 * 只有演示种子数据填了 1~8），追加键同样写在两个调用方的 `ORDER BY` 里：
 * `module-management.repository.ts`。
 */
export function lifecycleRankExpression(
  sql: ISql,
  scope: DerivedLifecycleScope,
  table: CardRowAlias,
) {
  const derived = sql`WHEN EXISTS (
               SELECT 1
                 FROM app.tasks t
                WHERE ${taskScopeWhere(sql, scope, table)}
                  AND t.work_status = 'DONE'
                  AND ${effectiveTaskWhere(sql)}
             ) THEN 0
             ELSE 1`;
  return sql`CASE ${derived} END`;
}

/** 项目卡统计列：活跃模块数、待办任务数、已完成任务数。 */
export function projectStatColumns(sql: ISql, table: "p" | "u") {
  const projectId = rowId(sql, table);
  return sql`
         (
           SELECT COUNT(*)::integer
             FROM app.modules mm
            WHERE mm.project_id = ${projectId}
              AND mm.status = 'ACTIVE'
              AND mm.deleted_at IS NULL
         ) AS "activeModuleCount",
         ${openTaskCountColumn(sql, "project", table)},
         ${completedTaskCountColumn(sql, "project", table)}`;
}

/** 模块卡统计列：模块内待办任务数与已完成任务数。 */
export function moduleStatColumns(sql: ISql, table: "m") {
  return sql`
         ${openTaskCountColumn(sql, "module", table)},
         ${completedTaskCountColumn(sql, "module", table)}`;
}
