import { Controller, HttpCode, Inject, Post, Req } from "@nestjs/common";
import type { TaskDraftAssistRequest } from "@inpulse/api-contract";

import type { HttpHeaderBag } from "../auth/csrf.http.js";
import {
  ContractBody,
  ContractPath,
  Operation,
} from "../http/contract.decorators.js";
import { TaskDraftAssistHttpService } from "./task-draft-assist-http.service.js";

/** 新建任务 AI 识别：项目内读取权限；纯校验接口，不创建任务、不写任何状态。 */
@Controller("projects")
export class TaskDraftAssistController {
  constructor(
    @Inject(TaskDraftAssistHttpService)
    private readonly service: TaskDraftAssistHttpService,
  ) {}

  @Post(":projectId/task-draft-assist")
  @HttpCode(200)
  @Operation("assistTaskDraft")
  assist(
    @Req() request: { headers: HttpHeaderBag },
    @ContractPath("assistTaskDraft") path: { projectId: number },
    @ContractBody("assistTaskDraft") body: TaskDraftAssistRequest,
  ) {
    return this.service.assist(request.headers, path.projectId, body);
  }
}
