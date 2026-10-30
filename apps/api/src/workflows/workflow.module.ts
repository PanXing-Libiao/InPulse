import { Module } from "@nestjs/common";

import { ProjectWriteAccessWorkflow } from "./project-write-access.workflow.js";

/**
 * 跨域 Workflow 的 Nest 模块。
 *
 * 当前仅提供父级写前检查编排；不挂入 AppModule，等待首个业务 Workflow
 * 或 Controller 接入后再按 AppModule 的鉴权装配条件启用。
 */
@Module({
  providers: [ProjectWriteAccessWorkflow],
  exports: [ProjectWriteAccessWorkflow],
})
export class WorkflowModule {}
