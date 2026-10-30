import { Injectable } from "@nestjs/common";
import type {
  AdminUserOffboardingProject,
  AdminUserOffboardingTask,
} from "@inpulse/api-contract";

import type { TransactionContext } from "../database/transaction-context.js";

interface TaskRow {
  readonly taskId: number;
  readonly projectId: number;
  readonly projectCode: string;
  readonly projectName: string;
  readonly moduleId: number;
  readonly code: string;
  readonly title: string;
  readonly rowVersion: number;
  readonly assigneeIds: number[];
  readonly assigneeNames: string[];
}

interface MemberRow {
  readonly projectId: number;
  readonly userId: number;
  readonly name: string;
  readonly avatarUrl: string | null;
}

interface LeaderProjectRow {
  readonly projectId: number;
  readonly projectCode: string;
  readonly projectName: string;
}

/** 停用账号的跨项目交接读模型；只按目标账号当前真实负责人关系生成。 */
@Injectable()
export class AdminUserOffboardingRepository {
  async load(
    tx: TransactionContext,
    userId: number,
  ): Promise<AdminUserOffboardingProject[]> {
    const tasks = (await tx.sql<TaskRow[]>`
      SELECT t.id AS "taskId",
             t.project_id AS "projectId",
             p.code AS "projectCode",
             p.name AS "projectName",
             t.module_id AS "moduleId",
             t.code,
             t.title,
             t.row_version AS "rowVersion",
             a.ids AS "assigneeIds",
             a.names AS "assigneeNames"
        FROM app.tasks AS t
        JOIN app.projects AS p ON p.id = t.project_id
        JOIN app.task_assignees AS self
          ON self.task_id = t.id
         AND self.project_id = t.project_id
         AND self.user_id = ${userId}
        JOIN LATERAL (
          SELECT array_agg(ta.user_id ORDER BY ta.user_id) AS ids,
                 array_agg(ta.user_snapshot->>'name' ORDER BY ta.user_id) AS names
            FROM app.task_assignees AS ta
           WHERE ta.task_id = t.id
             AND ta.project_id = t.project_id
        ) AS a ON true
       WHERE t.work_status = 'TODO'
         AND t.lifecycle_status = 'ACTIVE'
         AND t.deleted_at IS NULL
       ORDER BY p.id, t.id
    `) as unknown as readonly TaskRow[];

    const leaders = (await tx.sql<LeaderProjectRow[]>`
      SELECT p.id AS "projectId",
             p.code AS "projectCode",
             p.name AS "projectName"
        FROM app.project_members AS m
        JOIN app.projects AS p ON p.id = m.project_id
       WHERE m.user_id = ${userId}
         AND m.status = 'ACTIVE'
         AND m.role = 'LEADER'
       ORDER BY p.id
    `) as unknown as readonly LeaderProjectRow[];

    if (tasks.length === 0 && leaders.length === 0) return [];

    const projectIds = [
      ...new Set([
        ...tasks.map((task) => task.projectId),
        ...leaders.map((project) => project.projectId),
      ]),
    ].sort((left, right) => left - right);
    const members = (await tx.sql<MemberRow[]>`
      SELECT m.project_id AS "projectId",
             u.id AS "userId",
             u.name,
             u.avatar_url AS "avatarUrl"
        FROM app.project_members AS m
        JOIN app.users AS u ON u.id = m.user_id
       WHERE m.project_id = ANY(${projectIds}::integer[])
         AND m.status = 'ACTIVE'
         AND u.status = 'ACTIVE'
         AND u.disabled_at IS NULL
         AND u.id <> ${userId}
       ORDER BY m.project_id, u.id
    `) as unknown as readonly MemberRow[];

    const membersByProject = new Map<number, MemberRow[]>();
    for (const member of members) {
      const list = membersByProject.get(member.projectId) ?? [];
      list.push(member);
      membersByProject.set(member.projectId, list);
    }

    const leaderProjectIds = new Set(
      leaders.map((project) => project.projectId),
    );
    const projectMeta = new Map<
      number,
      { readonly projectCode: string; readonly projectName: string }
    >();
    for (const leader of leaders)
      projectMeta.set(leader.projectId, {
        projectCode: leader.projectCode,
        projectName: leader.projectName,
      });
    for (const row of tasks)
      if (!projectMeta.has(row.projectId))
        projectMeta.set(row.projectId, {
          projectCode: row.projectCode,
          projectName: row.projectName,
        });

    const projects = new Map<number, AdminUserOffboardingProject>();
    for (const projectId of [...projectMeta.keys()].sort(
      (left, right) => left - right,
    )) {
      const meta = projectMeta.get(projectId);
      if (meta === undefined) continue;
      projects.set(projectId, {
        projectId,
        projectCode: meta.projectCode,
        projectName: meta.projectName,
        tasks: [],
        members: (membersByProject.get(projectId) ?? []).map((member) => ({
          userId: member.userId,
          name: member.name,
          avatarUrl: member.avatarUrl,
        })),
        requiresLeaderTransfer: leaderProjectIds.has(projectId),
      });
    }
    for (const row of tasks) {
      const project = projects.get(row.projectId);
      if (project === undefined) {
        throw new Error("offboarding project was not initialized");
      }
      const task: AdminUserOffboardingTask = {
        taskId: row.taskId,
        projectId: row.projectId,
        moduleId: row.moduleId,
        code: row.code,
        title: row.title,
        rowVersion: row.rowVersion,
        assignees: row.assigneeIds.map((assigneeId, index) => ({
          userId: assigneeId,
          name: row.assigneeNames[index] ?? "",
        })),
        requiresHandover: row.assigneeIds.length === 1,
      };
      project.tasks.push(task);
    }
    return [...projects.values()];
  }
}
