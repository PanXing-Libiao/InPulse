import { Controller, HttpCode, Inject, Post, Req } from "@nestjs/common";
import type { TaskDraftAssistRequest } from "@inpulse/api-contract";

import type { HttpHeaderBag } from "../auth/csrf.http.js";
import { ContractBody, Operation } from "../http/contract.decorators.js";
import { TaskDraftAssistHttpService } from "./task-draft-assist-http.service.js";

/**
 * 未选择项目时的任务草稿识别：只读会话，不读取任何项目数据。
 * 与项目内识别共用响应结构，但模块、功能、负责人一律留空，
 * 让用户先看截图内容，选好项目后再确认归属。
 */
@Controller()
export class TaskDraftAssistStandaloneController {
  constructor(
    @Inject(TaskDraftAssistHttpService)
    private readonly service: TaskDraftAssistHttpService,
  ) {}

  @Post("task-draft-assist")
  @HttpCode(200)
  @Operation("assistTaskDraftStandalone")
  assist(
    @Req() request: { headers: HttpHeaderBag },
    @ContractBody("assistTaskDraftStandalone") body: TaskDraftAssistRequest,
  ) {
    return this.service.assistStandalone(request.headers, body);
  }
}
