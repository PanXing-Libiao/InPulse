import { taskCenterQuerySchema } from "./contracts/aggregate-read.zod.js";
import { taskCreateSchemas } from "./contracts/task-create.zod.js";
import { wecomBindingSchemas } from "./contracts/wecom-binding.zod.js";
import { adminAiAssistSchemas } from "./contracts/admin-ai-assist.zod.js";
import { wecomRobotSchemas } from "./contracts/wecom-robot.zod.js";
import { projectMemberPermissionSchemas } from "./contracts/project-member-permissions.zod.js";
import { projectWecomGroupSchemas } from "./contracts/project-wecom-group.zod.js";
import { organizationSchemas } from "./contracts/organization.zod.js";
import {
  casdoorImportCountsSchema,
  casdoorImportPreviewItemSchema,
  casdoorImportPreviewResponseSchema,
  casdoorImportRequestSchema,
  casdoorImportResultSchema,
} from "./contracts/casdoor-import.zod.js";
import { documentImportSchemas } from "./contracts/document-import.zod.js";
import {
  auditLogItemSchema,
  auditLogPageSchema,
  auditLogQueryRequestSchema,
} from "./contracts/audit.zod.js";
import { externalLinkSchemas } from "./contracts/external-links.zod.js";
import { leftoverTaskSchemas } from "./contracts/leftover-task.zod.js";
import { taskCompletionSchemas } from "./contracts/task-completion.zod.js";
import { taskDeletionSchemas } from "./contracts/task-deletion.zod.js";
import { taskGroupSchemas } from "./contracts/task-groups.zod.js";
import {
  aggregateTaskRefSchema,
  leftoverItemPageSchema,
  leftoverListItemSchema,
  leftoverListQueryRequestSchema,
  leftoverItemSummarySchema,
  myTaskItemSchema,
  myTaskLeftoverSampleSchema,
  myTaskPageSchema,
  myTaskStatsSchema,
  myTaskTodayTodoBreakdownSchema,
  myTasksQueryRequestSchema,
  projectOverviewProjectSchema,
  projectOverviewQueryRequestSchema,
  projectOverviewResponseSchema,
  projectOverviewStatsSchema,
  recentRecordItemSchema,
  taskGroupDetailResponseSchema,
  taskGroupListBranchSchema,
  taskGroupListItemSchema,
  taskGroupListPageSchema,
  taskGroupListQueryRequestSchema,
  taskGroupMemberDetailSchema,
  taskGroupPathSchema,
  taskGroupRecordItemSchema,
  taskGroupRecordLinkSchema,
  taskGroupRecordPageSchema,
  taskGroupMembershipItemSchema,
  taskGroupMembershipQueryRequestSchema,
  taskGroupMembershipResponseSchema,
  taskGroupRecordQueryRequestSchema,
  taskGroupSummarySchema,
  userRefSchema,
} from "./contracts/aggregate-read.zod.js";
import { recordDraftSchemas } from "./contracts/record-drafts.zod.js";
import { recordFeedSchemas } from "./contracts/record-feed.zod.js";
import { recordSummarySchemas } from "./contracts/record-summary.zod.js";
import { recordSummaryAssistSchemas } from "./contracts/record-summary-assist.zod.js";
import { publishedRecordSchemas } from "./contracts/published-records.zod.js";
import { taskSchemas } from "./contracts/tasks.zod.js";
import type { z } from "zod";
import { moduleSchemas } from "./contracts/modules.zod.js";
import { moduleDeletionSchemas } from "./contracts/module-deletion.zod.js";
import {
  taskBoardCardSchema,
  taskBoardModuleSchema,
  taskBoardModuleStatsSchema,
  taskBoardProjectSchema,
  taskBoardResponseSchema,
  taskBoardStatsSchema,
} from "./contracts/task-board.zod.js";

import {
  currentUserResponseSchema,
  loginHeadersSchema,
  loginRequestSchema,
  loginResponseSchema,
  logoutHeadersSchema,
  userAuthStateSchema,
} from "./contracts/auth.zod.js";
import { csrfIssueResponseSchema } from "./contracts/csrf.zod.js";
import {
  ssoCallbackQueryRequestSchema,
  ssoStartQueryRequestSchema,
} from "./contracts/sso.zod.js";
import { errorResponseSchema } from "./contracts/error.zod.js";
import { healthResponseSchema } from "./contracts/health.zod.js";
import {
  activityDayTotalSchema,
  activityFeedQueryRequestSchema,
  activityItemSchema,
  activityPageSchema,
  activityPathSchema,
  activityQueryRequestSchema,
} from "./contracts/activity.zod.js";
import {
  notificationItemSchema,
  notificationPageSchema,
  notificationPathSchema,
  notificationPreferencesSchema,
  notificationPreferencesUpdateRequestSchema,
  notificationQueryRequestSchema,
  notificationMuteQueryRequestSchema,
  notificationReplayContextSchema,
  notificationUnreadCountResponseSchema,
} from "./contracts/notification.zod.js";
import {
  searchItemSchema,
  searchPageSchema,
  searchQueryRequestSchema,
} from "./contracts/search.zod.js";
import {
  activeProjectMemberItemSchema,
  activeProjectMembersResponseSchema,
  createProjectHeadersSchema,
  createProjectReplayContextSchema,
  createProjectRequestSchema,
  createProjectResponseSchema,
  projectMemberItemSchema,
  projectMemberCollectionPathSchema,
  projectMemberPathSchema,
  projectMemberRecordItemSchema,
  projectMembersListResponseSchema,
  addProjectMemberRequestSchema,
  projectMemberMutationHeadersSchema,
  projectMemberUnfinishedTaskItemSchema,
  projectMemberUnfinishedTasksResponseSchema,
  projectMemberReassignmentItemSchema,
  removeProjectMemberRequestSchema,
  addProjectMemberResponseSchema,
  removeProjectMemberResponseSchema,
  projectMemberReplayContextSchema,
  setProjectMemberRoleRequestSchema,
  setProjectMemberRoleResponseSchema,
  projectCodeSchema,
  projectStatusSchema,
  projectItemSchema,
  projectListResponseSchema,
  projectDetailResponseSchema,
  projectPathSchema,
  projectEditRequestSchema,
  projectStatusChangeRequestSchema,
  projectMutationHeadersSchema,
  projectVersionHeadersSchema,
  projectReplayContextSchema,
} from "./contracts/projects.zod.js";
import {
  adminUserCreateRequestSchema,
  adminUserDisableRequestSchema,
  adminUserItemSchema,
  adminUserListResponseSchema,
  adminUserMutationHeadersSchema,
  adminUserOffboardingResponseSchema,
  adminUserPathSchema,
  adminUserReplayContextSchema,
  adminUserUpdateRequestSchema,
  adminUserVersionHeadersSchema,
  userDirectoryItemSchema,
  userDirectoryResponseSchema,
} from "./contracts/users.zod.js";

export interface SchemaRegistryEntry {
  readonly schema: z.ZodType;
  readonly summary: string;
  /**
   * 技术设计 4.1.1 / ADR-019：标为敏感的叶子字段路径禁止进入幂等重放策略。
   * 路径记法与 collectLeafPaths 一致（对象用 `.`，数组用 `[]`）。
   */
  readonly sensitiveFieldPaths: readonly string[];
}

/**
 * Schema Registry 是请求与响应数据结构的唯一来源（技术设计 4.1）。
 * 每个条目必须通过 `.meta({ id })` 声明与键名一致的 OpenAPI 组件名。
 */
export const schemaRegistry = {
  ...externalLinkSchemas,
  ...taskCompletionSchemas,
  ...taskDeletionSchemas,
  ...leftoverTaskSchemas,
  ...moduleSchemas,
  ...moduleDeletionSchemas,
  ...taskCreateSchemas,
  ...documentImportSchemas,
  ...wecomBindingSchemas,
  ...adminAiAssistSchemas,
  ...wecomRobotSchemas,
  ...projectMemberPermissionSchemas,
  ...projectWecomGroupSchemas,
  ...organizationSchemas,
  TaskCenterQuery: {
    schema: taskCenterQuerySchema,
    summary: "授权范围内任务中心筛选",
    sensitiveFieldPaths: [],
  },
  ...taskSchemas,
  ...recordDraftSchemas,
  ...publishedRecordSchemas,
  ...recordFeedSchemas,
  ...recordSummarySchemas,
  ...recordSummaryAssistSchemas,

  ...taskGroupSchemas,
  UserRef: {
    schema: userRefSchema,
    summary: "聚合读共用的用户引用，只含姓名与头像",
    sensitiveFieldPaths: [],
  },
  TaskGroupPath: {
    schema: taskGroupPathSchema,
    summary: "聚合组路径参数，项目归属由服务端反查（Q-01）",
    sensitiveFieldPaths: [],
  },
  TaskGroupSummary: {
    schema: taskGroupSummarySchema,
    summary: "聚合组摘要：编码、名称、状态与版本（R-1）",
    sensitiveFieldPaths: [],
  },
  TaskGroupMemberDetail: {
    schema: taskGroupMemberDetailSchema,
    summary: "聚合组成员明细：角色、分支类型、成员状态与任务原数据（R-1）",
    sensitiveFieldPaths: [],
  },
  TaskGroupDetailResponse: {
    schema: taskGroupDetailResponseSchema,
    summary: "聚合组视图响应，记录列表由子资源分页提供（R-1 / Q-02）",
    sensitiveFieldPaths: [],
  },
  TaskGroupRecordQueryRequest: {
    schema: taskGroupRecordQueryRequestSchema,
    summary: "聚合组记录查询参数：成员任务、游标与每页条数（R-4）",
    sensitiveFieldPaths: [],
  },
  TaskGroupRecordLink: {
    schema: taskGroupRecordLinkSchema,
    summary: "记录上的 GitHub 链接，标题与状态为关联时刻快照（R-4 / Q-14）",
    sensitiveFieldPaths: [],
  },
  TaskGroupRecordItem: {
    schema: taskGroupRecordItemSchema,
    summary: "聚合组记录条目，只含 PUBLISHED 与 VOID（R-4 / Q-13）",
    sensitiveFieldPaths: [],
  },
  TaskGroupRecordPage: {
    schema: taskGroupRecordPageSchema,
    summary: "聚合组记录分页响应（R-4 / C-006）",
    sensitiveFieldPaths: [],
  },
  ProjectOverviewQueryRequest: {
    schema: projectOverviewQueryRequestSchema,
    summary: "项目概览收口参数：最近迭代与遗留问题条数（R-2 / Q-06）",
    sensitiveFieldPaths: [],
  },
  ProjectOverviewProject: {
    schema: projectOverviewProjectSchema,
    summary: "项目概览项目头，返回原始状态枚举（R-2 / Q-15）",
    sensitiveFieldPaths: [],
  },
  ProjectOverviewStats: {
    schema: projectOverviewStatsSchema,
    summary: "项目概览四项统计，口径按功能设计 §29（R-2）",
    sensitiveFieldPaths: [],
  },
  RecentRecordItem: {
    schema: recentRecordItemSchema,
    summary: "最近迭代条目，含所属模块名（R-2）",
    sensitiveFieldPaths: [],
  },
  LeftoverItemSummary: {
    schema: leftoverItemSummarySchema,
    summary: "待处理遗留问题条目，内容取最新版本快照（R-2）",
    sensitiveFieldPaths: [],
  },
  ProjectOverviewResponse: {
    schema: projectOverviewResponseSchema,
    summary: "项目概览响应：项目头、成员数与聚合结果（R-2）",
    sensitiveFieldPaths: [],
  },
  TaskBoardProject: {
    schema: taskBoardProjectSchema,
    summary: "任务看板项目头，返回原始状态枚举（R-8）",
    sensitiveFieldPaths: [],
  },
  TaskBoardStats: {
    schema: taskBoardStatsSchema,
    summary:
      "任务看板项目级统计：完成率、状态计数、逾期、今日到期、本周完成、模块数与成员数（R-8）",
    sensitiveFieldPaths: [],
  },
  TaskBoardCard: {
    schema: taskBoardCardSchema,
    summary:
      "任务看板卡片：优先级、状态、截止与完成时间、服务端截止状态、负责人与 PUBLISHED 记录数（R-8）",
    sensitiveFieldPaths: [],
  },
  TaskBoardModuleStats: {
    schema: taskBoardModuleStatsSchema,
    summary: "任务看板泳道统计（R-8）",
    sensitiveFieldPaths: [],
  },
  TaskBoardModule: {
    schema: taskBoardModuleSchema,
    summary: "任务看板泳道：模块任务数、统计、负责人头像组与任务卡（R-8）",
    sensitiveFieldPaths: [],
  },
  TaskBoardResponse: {
    schema: taskBoardResponseSchema,
    summary: "任务看板响应：项目头、生成时间、项目级统计与模块泳道（R-8）",
    sensitiveFieldPaths: [],
  },
  MyTasksQueryRequest: {
    schema: myTasksQueryRequestSchema,
    summary:
      "我的任务查询参数：筛选与游标（含 todayTodo 今日待办），负责人 / 创建人固定为当前用户（R-3）",
    sensitiveFieldPaths: [],
  },
  MyTaskItem: {
    schema: myTaskItemSchema,
    summary:
      "我的任务条目，含优先级、截止、完成时间、创建者、外部链接数、聚合组角色与遗留问题来源标记（R-3 / §10.3 / D-2）",
    sensitiveFieldPaths: [],
  },
  MyTaskStats: {
    schema: myTaskStatsSchema,
    summary:
      "我的任务统计卡片：今日待办、未完成、已完成（负责人维度）与我创建的（创建人维度），日界按业务时区 Asia/Shanghai（R-3 / 2026-09-20 口径）",
    sensitiveFieldPaths: [],
  },
  MyTaskTodayTodoBreakdown: {
    schema: myTaskTodayTodoBreakdownSchema,
    summary:
      "今日待办的四个来源子计数：逾期 / 遗留来源 / 标记紧急 / 7 个日历日内到期，四项可重叠（R-3 / 2026-09-20）",
    sensitiveFieldPaths: [],
  },
  MyTaskLeftoverSample: {
    schema: myTaskLeftoverSampleSchema,
    summary:
      "我的任务遗留问题入口样例：记录编号与最新版本内容摘要（R-3 / §10.3）",
    sensitiveFieldPaths: [],
  },
  MyTaskPage: {
    schema: myTaskPageSchema,
    summary:
      "我的任务分页响应，附统计卡片与遗留问题入口（R-3 / C-006 / §10.3）",
    sensitiveFieldPaths: [],
  },
  TaskGroupMembershipQueryRequest: {
    schema: taskGroupMembershipQueryRequestSchema,
    summary: "任务卡片聚合关系批量查询参数：逗号分隔的 1..100 个任务 ID（R-5）",
    sensitiveFieldPaths: [],
  },
  TaskGroupMembershipItem: {
    schema: taskGroupMembershipItemSchema,
    summary:
      "任务卡片聚合关系条目：任务、聚合组、组内角色与遗留问题来源标记（R-5 / §10.4 / D-2）",
    sensitiveFieldPaths: [],
  },
  TaskGroupMembershipResponse: {
    schema: taskGroupMembershipResponseSchema,
    summary: "任务卡片聚合关系批量响应，按 taskId 升序（R-5 / §10.4）",
    sensitiveFieldPaths: [],
  },
  AggregateTaskRef: {
    schema: aggregateTaskRefSchema,
    summary: "聚合读共用的任务引用，只含任务 ID 与编号（R-6 / R-7）",
    sensitiveFieldPaths: [],
  },
  LeftoverListQueryRequest: {
    schema: leftoverListQueryRequestSchema,
    summary: "遗留问题列表查询参数：分桶、项目收窄与游标（R-6）",
    sensitiveFieldPaths: [],
  },
  LeftoverListItem: {
    schema: leftoverListItemSchema,
    summary: "遗留问题条目：最新快照内容、来源任务与跟进任务引用（R-6）",
    sensitiveFieldPaths: [],
  },
  LeftoverItemPage: {
    schema: leftoverItemPageSchema,
    summary: "遗留问题分页响应（R-6 / C-006）",
    sensitiveFieldPaths: [],
  },
  TaskGroupListQueryRequest: {
    schema: taskGroupListQueryRequestSchema,
    summary: "聚合组列表查询参数：项目收窄与游标（R-7）",
    sensitiveFieldPaths: [],
  },
  TaskGroupListBranch: {
    schema: taskGroupListBranchSchema,
    summary: "聚合组列表分支：只含生效成员与任务原数据（R-7）",
    sensitiveFieldPaths: [],
  },
  TaskGroupListItem: {
    schema: taskGroupListItemSchema,
    summary: "聚合组列表条目：组标识、项目名与生效分支（R-7）",
    sensitiveFieldPaths: [],
  },
  TaskGroupListPage: {
    schema: taskGroupListPageSchema,
    summary: "聚合组分页响应（R-7 / C-006）",
    sensitiveFieldPaths: [],
  },
  ErrorResponse: {
    schema: errorResponseSchema,
    summary: "统一错误响应模型",
    sensitiveFieldPaths: [],
  },
  HealthResponse: {
    schema: healthResponseSchema,
    summary: "存活探针响应",
    sensitiveFieldPaths: [],
  },
  CsrfIssueResponse: {
    schema: csrfIssueResponseSchema,
    summary: "CSRF 同步 Token 签发响应",
    sensitiveFieldPaths: ["csrfToken"],
  },
  LoginHeaders: {
    schema: loginHeadersSchema,
    summary: "登录请求头",
    sensitiveFieldPaths: ["x-csrf-token"],
  },
  LoginRequest: {
    schema: loginRequestSchema,
    summary: "登录请求体",
    sensitiveFieldPaths: ["password"],
  },
  LoginResponse: {
    schema: loginResponseSchema,
    summary: "登录成功响应，返回绑定新 Session 的 CSRF Token 与显式认证状态",
    sensitiveFieldPaths: ["csrfToken"],
  },
  LogoutHeaders: {
    schema: logoutHeadersSchema,
    summary: "登出请求头；有效 Session 必须携带当前 CSRF Token",
    sensitiveFieldPaths: ["x-csrf-token"],
  },
  SsoStartQueryRequest: {
    schema: ssoStartQueryRequestSchema,
    summary:
      "单点登录发起参数；returnTo 为站内相对路径，服务端二次校验后写入 state",
    sensitiveFieldPaths: [],
  },
  SsoCallbackQueryRequest: {
    schema: ssoCallbackQueryRequestSchema,
    summary: "单点登录回调参数；code 与 state 是一次性材料，不落库明文",
    sensitiveFieldPaths: ["code", "state"],
  },
  SearchQueryRequest: {
    schema: searchQueryRequestSchema,
    summary:
      "全局搜索查询参数；cursor 为服务端签名的不透明字符串，limit 默认 20、最大 50",
    sensitiveFieldPaths: [],
  },
  SearchItem: {
    schema: searchItemSchema,
    summary: "搜索结果条目，entityType 为稳定判别字段",
    sensitiveFieldPaths: [],
  },
  SearchPage: {
    schema: searchPageSchema,
    summary: "全局搜索分页结果",
    sensitiveFieldPaths: [],
  },
  AuditLogQueryRequest: {
    schema: auditLogQueryRequestSchema,
    summary:
      "原始审计查询参数；不传 projectId 读 SYSTEM 链，cursor 为服务端签名的不透明字符串，limit 默认 50、最大 100",
    sensitiveFieldPaths: [],
  },
  AuditLogItem: {
    schema: auditLogItemSchema,
    summary: "原始审计条目；只对系统管理员可见，包含事件负载与链哈希",
    sensitiveFieldPaths: [],
  },
  AuditLogPage: {
    schema: auditLogPageSchema,
    summary: "原始审计分页结果",
    sensitiveFieldPaths: [],
  },
  ActivityPath: {
    schema: activityPathSchema,
    summary: "项目动态路径参数",
    sensitiveFieldPaths: [],
  },
  ActivityQueryRequest: {
    schema: activityQueryRequestSchema,
    summary:
      "项目动态查询参数；includeAdminOnly 仅系统管理员显式开启时扩大服务端范围，category 按 chip 分类在 SQL 层过滤",
    sensitiveFieldPaths: [],
  },
  ActivityFeedQueryRequest: {
    schema: activityFeedQueryRequestSchema,
    summary:
      "聚合动态查询参数；projectIds 为逗号分隔的 1..100 个正整数（越权或未知项目静默排除），缺省为授权范围加全部已删除项目；cursor 为服务端签名的全局游标",
    sensitiveFieldPaths: [],
  },
  ActivityItem: {
    schema: activityItemSchema,
    summary: "项目动态白名单条目，不包含原始审计快照",
    sensitiveFieldPaths: [],
  },
  ActivityDayTotal: {
    schema: activityDayTotalSchema,
    summary:
      "一个 Asia/Shanghai 自然日的动态总数；按全量口径统计，不随分页加载增长",
    sensitiveFieldPaths: [],
  },
  ActivityPage: {
    schema: activityPageSchema,
    summary:
      "项目动态分页结果；dayTotals 为按日全量总数，dayTotalsTruncated 为真时只覆盖最近的 400 个自然日",
    sensitiveFieldPaths: [],
  },
  NotificationPath: {
    schema: notificationPathSchema,
    summary: "站内通知路径参数",
    sensitiveFieldPaths: [],
  },
  NotificationQueryRequest: {
    schema: notificationQueryRequestSchema,
    summary: "当前用户通知列表查询参数",
    sensitiveFieldPaths: [],
  },
  NotificationMuteQueryRequest: {
    schema: notificationMuteQueryRequestSchema,
    summary: "站内通知按项目关闭类别过滤的只读查询参数",
    sensitiveFieldPaths: [],
  },
  NotificationItem: {
    schema: notificationItemSchema,
    summary: "当前用户的一条站内通知",
    sensitiveFieldPaths: [],
  },
  NotificationPage: {
    schema: notificationPageSchema,
    summary: "当前用户通知分页结果",
    sensitiveFieldPaths: [],
  },
  NotificationUnreadCountResponse: {
    schema: notificationUnreadCountResponseSchema,
    summary: "当前用户未读通知数",
    sensitiveFieldPaths: [],
  },
  NotificationReplayContext: {
    schema: notificationReplayContextSchema,
    summary: "单条通知写操作的最小重放授权上下文",
    sensitiveFieldPaths: [],
  },
  NotificationPreferences: {
    schema: notificationPreferencesSchema,
    summary:
      "当前用户的个人通知偏好；disabledSettings 列出被关闭的设置项，缺省全部开启",
    sensitiveFieldPaths: [],
  },
  NotificationPreferencesUpdateRequest: {
    schema: notificationPreferencesUpdateRequestSchema,
    summary: "整组替换个人通知偏好；disabledSettings 去重并排序",
    sensitiveFieldPaths: [],
  },
  ProjectCode: {
    schema: projectCodeSchema,
    summary: "项目编码；创建后不可修改",
    sensitiveFieldPaths: [],
  },
  ProjectPath: {
    schema: projectPathSchema,
    summary: "项目详情路径参数",
    sensitiveFieldPaths: [],
  },
  ProjectStatus: {
    schema: projectStatusSchema,
    summary:
      "项目生命周期三态：未开始 / 进行中 / 维护中（ADR-043 起不再有归档态）",
    sensitiveFieldPaths: [],
  },
  ProjectItem: {
    schema: projectItemSchema,
    summary: "项目公开摘要；包含三态状态、粘性完成标记与活跃成员数",
    sensitiveFieldPaths: [],
  },
  ProjectListResponse: {
    schema: projectListResponseSchema,
    summary: "当前用户可见项目列表；系统管理员返回全部项目",
    sensitiveFieldPaths: [],
  },
  ProjectDetailResponse: {
    schema: projectDetailResponseSchema,
    summary: "当前用户可访问项目详情；无权限统一 404",
    sensitiveFieldPaths: [],
  },
  CreateProjectRequest: {
    schema: createProjectRequestSchema,
    summary:
      "创建项目请求；创建者由服务端 Session 解析，memberIds 为可选项目成员",
    sensitiveFieldPaths: [],
  },
  CreateProjectHeaders: {
    schema: createProjectHeadersSchema,
    summary: "创建项目请求头，要求同步 CSRF Token",
    sensitiveFieldPaths: ["x-csrf-token"],
  },
  ProjectMemberItem: {
    schema: projectMemberItemSchema,
    summary: "项目成员摘要（响应与幂等重放共享）",
    sensitiveFieldPaths: [],
  },
  ProjectMemberCollectionPath: {
    schema: projectMemberCollectionPathSchema,
    summary: "项目成员集合路径参数",
    sensitiveFieldPaths: [],
  },
  ProjectMemberPath: {
    schema: projectMemberPathSchema,
    summary: "项目成员资源路径参数",
    sensitiveFieldPaths: [],
  },
  ProjectMemberRecordItem: {
    schema: projectMemberRecordItemSchema,
    summary: "项目成员历史记录及脱敏展示字段",
    sensitiveFieldPaths: [],
  },
  ProjectMembersListResponse: {
    schema: projectMembersListResponseSchema,
    summary: "系统管理员项目成员历史列表",
    sensitiveFieldPaths: [],
  },
  ActiveProjectMemberItem: {
    schema: activeProjectMemberItemSchema,
    summary: "只读成员卡片可见字段：姓名、头像、项目内角色与加入时间",
    sensitiveFieldPaths: [],
  },
  ActiveProjectMembersResponse: {
    schema: activeProjectMembersResponseSchema,
    summary: "普通成员只读项目成员列表（活跃成员与项目内角色）",
    sensitiveFieldPaths: [],
  },
  AddProjectMemberRequest: {
    schema: addProjectMemberRequestSchema,
    summary: "系统管理员添加项目成员请求",
    sensitiveFieldPaths: [],
  },
  ProjectMemberMutationHeaders: {
    schema: projectMemberMutationHeadersSchema,
    summary: "成员写请求安全头，要求同步 CSRF Token",
    sensitiveFieldPaths: ["x-csrf-token"],
  },
  ProjectMemberUnfinishedTaskItem: {
    schema: projectMemberUnfinishedTaskItemSchema,
    summary: "成员未完成任务及改派所需版本信息",
    sensitiveFieldPaths: [],
  },
  ProjectMemberUnfinishedTasksResponse: {
    schema: projectMemberUnfinishedTasksResponseSchema,
    summary: "成员未完成任务列表",
    sensitiveFieldPaths: [],
  },
  ProjectMemberReassignmentItem: {
    schema: projectMemberReassignmentItemSchema,
    summary: "成员移除时单任务改派参数（可指定一位或多位接手成员）",
    sensitiveFieldPaths: [],
  },
  RemoveProjectMemberRequest: {
    schema: removeProjectMemberRequestSchema,
    summary: "系统管理员移除项目成员及可选任务改派请求",
    sensitiveFieldPaths: [],
  },
  AddProjectMemberResponse: {
    schema: addProjectMemberResponseSchema,
    summary: "添加项目成员成功响应",
    sensitiveFieldPaths: [],
  },
  RemoveProjectMemberResponse: {
    schema: removeProjectMemberResponseSchema,
    summary: "移除项目成员成功响应",
    sensitiveFieldPaths: [],
  },
  ProjectMemberReplayContext: {
    schema: projectMemberReplayContextSchema,
    summary: "成员写操作幂等重放的最小结果资源上下文",
    sensitiveFieldPaths: [],
  },
  SetProjectMemberRoleRequest: {
    schema: setProjectMemberRoleRequestSchema,
    summary: "ADR-033 任命/撤销项目内角色请求",
    sensitiveFieldPaths: [],
  },
  SetProjectMemberRoleResponse: {
    schema: setProjectMemberRoleResponseSchema,
    summary: "角色设置成功响应（200）",
    sensitiveFieldPaths: [],
  },
  CreateProjectResponse: {
    schema: createProjectResponseSchema,
    summary: "创建项目成功响应（200）",
    sensitiveFieldPaths: [],
  },
  CreateProjectReplayContext: {
    schema: createProjectReplayContextSchema,
    summary: "创建项目幂等重放的最小资源授权上下文",
    sensitiveFieldPaths: [],
  },
  ProjectEditRequest: {
    schema: projectEditRequestSchema,
    summary: "项目编辑请求；编码不可修改，名称与描述整笔替换",
    sensitiveFieldPaths: [],
  },
  ProjectStatusChangeRequest: {
    schema: projectStatusChangeRequestSchema,
    summary: "项目状态变更请求；只接受未开始 / 进行中 / 维护中",
    sensitiveFieldPaths: [],
  },
  ProjectMutationHeaders: {
    schema: projectMutationHeadersSchema,
    summary: "项目写请求安全头，要求同步 CSRF Token",
    sensitiveFieldPaths: ["x-csrf-token"],
  },
  ProjectVersionHeaders: {
    schema: projectVersionHeadersSchema,
    summary: "项目编辑版本头，If-Match 防止并发覆盖",
    sensitiveFieldPaths: ["x-csrf-token"],
  },
  ProjectReplayContext: {
    schema: projectReplayContextSchema,
    summary: "项目写操作幂等重放的最小结果资源上下文",
    sensitiveFieldPaths: [],
  },
  UserAuthState: {
    schema: userAuthStateSchema,
    summary: "用户 Session 显式认证状态",
    sensitiveFieldPaths: [],
  },
  CurrentUserResponse: {
    schema: currentUserResponseSchema,
    summary: "当前登录用户资料",
    sensitiveFieldPaths: [],
  },
  UserDirectoryItem: {
    schema: userDirectoryItemSchema,
    summary:
      "用户目录公开条目（含组织归属），用于创建项目时按组织或按人选择项目成员",
    sensitiveFieldPaths: [],
  },
  UserDirectoryResponse: {
    schema: userDirectoryResponseSchema,
    summary: "全部启用用户的轻量目录；响应 no-store",
    sensitiveFieldPaths: [],
  },
  CasdoorImportRequest: {
    schema: casdoorImportRequestSchema,
    summary:
      "Casdoor 批量导入确认请求；只接受预览后勾选的 Casdoor 账号稳定标识",
    sensitiveFieldPaths: [],
  },
  CasdoorImportCounts: {
    schema: casdoorImportCountsSchema,
    summary: "Casdoor 目录预览按创建、绑定、刷新、跳过分类的计数",
    sensitiveFieldPaths: [],
  },
  CasdoorImportPreviewItem: {
    schema: casdoorImportPreviewItemSchema,
    summary: "Casdoor 导入预览条目；仅含脱敏身份、Physical 组路径与动作分类",
    sensitiveFieldPaths: [],
  },
  CasdoorImportPreviewResponse: {
    schema: casdoorImportPreviewResponseSchema,
    summary:
      "Casdoor 导入预览；管理员实时读取配置组织，响应 no-store 且不含凭据",
    sensitiveFieldPaths: [],
  },
  CasdoorImportResult: {
    schema: casdoorImportResultSchema,
    summary:
      "Casdoor 批量导入结果计数；不返回账号邮箱、Casdoor 标识或原始目录响应",
    sensitiveFieldPaths: [],
  },
  AdminUserPath: {
    schema: adminUserPathSchema,
    summary: "用户管理路径参数",
    sensitiveFieldPaths: [],
  },
  AdminUserCreateRequest: {
    schema: adminUserCreateRequestSchema,
    summary: "系统管理员新增用户请求；密码在请求中出现但不会持久化明文",
    sensitiveFieldPaths: ["password"],
  },
  AdminUserUpdateRequest: {
    schema: adminUserUpdateRequestSchema,
    summary: "用户资料与管理员角色编辑请求",
    sensitiveFieldPaths: [],
  },
  AdminUserOffboardingResponse: {
    schema: adminUserOffboardingResponseSchema,
    summary:
      "停用账号前的按项目交接清单；包含未完成任务、负责人和可接手的项目成员",
    sensitiveFieldPaths: [],
  },
  AdminUserDisableRequest: {
    schema: adminUserDisableRequestSchema,
    summary:
      "停用账号时的任务接手与删除动作；未列出的多负责人任务由服务端保留其他负责人",
    sensitiveFieldPaths: [],
  },
  AdminUserMutationHeaders: {
    schema: adminUserMutationHeadersSchema,
    summary: "用户管理创建请求头，要求同步 CSRF Token",
    sensitiveFieldPaths: ["x-csrf-token"],
  },
  AdminUserVersionHeaders: {
    schema: adminUserVersionHeadersSchema,
    summary: "用户管理版本写请求头，要求同步 CSRF Token 与 If-Match",
    sensitiveFieldPaths: ["x-csrf-token"],
  },
  AdminUserItem: {
    schema: adminUserItemSchema,
    summary: "管理员用户管理公开条目；不暴露密码哈希或认证材料",
    sensitiveFieldPaths: [],
  },
  AdminUserListResponse: {
    schema: adminUserListResponseSchema,
    summary: "管理员用户列表；响应 no-store",
    sensitiveFieldPaths: [],
  },
  AdminUserReplayContext: {
    schema: adminUserReplayContextSchema,
    summary: "用户管理幂等重放的最小结果资源上下文",
    sensitiveFieldPaths: [],
  },
} satisfies Record<string, SchemaRegistryEntry>;

export type SchemaName = keyof typeof schemaRegistry;

export const schemaNames = Object.keys(schemaRegistry) as readonly SchemaName[];

export function isSchemaName(value: string): value is SchemaName {
  return Object.hasOwn(schemaRegistry, value);
}
