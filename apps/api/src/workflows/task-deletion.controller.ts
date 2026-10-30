import { Controller, Post, Inject, Req, Res } from "@nestjs/common";
import {
  Operation,
  ContractPath,
  ContractQuery,
  ContractBody,
  ContractHeaders,
} from "../http/contract.decorators.js";
import type { CompletionHttpRequest } from "./task-completion-http.service.js";
import { TaskDeletionHttpService } from "./task-deletion-http.service.js";
interface Response {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}
@Controller("projects")
export class TaskDeletionController {
  constructor(
    @Inject(TaskDeletionHttpService)
    private readonly service: TaskDeletionHttpService,
  ) {}
  @Post(":projectId/modules/:moduleId/tasks/:taskId/delete")
  @Operation("deleteModuleTask")
  async deleteModuleTask(
    @Req() request: CompletionHttpRequest,
    @Res({ passthrough: true }) response: Response,
    @ContractPath("deleteModuleTask") params: unknown,
    @ContractQuery("deleteModuleTask") query: unknown,
    @ContractBody("deleteModuleTask") body: unknown,
    @ContractHeaders("deleteModuleTask") _headers: unknown,
  ) {
    const result = await this.service.handle("deleteModuleTask", {
      ...request,
      headers: request.headers,
      params,
      query,
      body,
    });
    response.status(result.status);
    response.setHeader("Cache-Control", "no-store");
    if (result.status >= 400)
      response.setHeader(
        "X-Request-Id",
        (result.body as { requestId: string }).requestId,
      );
    return result.body;
  }
}
