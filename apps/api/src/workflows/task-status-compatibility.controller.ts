import { Controller, Post, Inject, Req, Res } from "@nestjs/common";
import {
  Operation,
  ContractPath,
  ContractQuery,
  ContractBody,
  ContractHeaders,
} from "../http/contract.decorators.js";
import type { CompletionHttpRequest } from "./task-completion-http.service.js";
import { TaskStatusCompatibilityHttpService } from "./task-status-compatibility-http.service.js";
interface Response {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}
@Controller("projects")
export class TaskStatusCompatibilityController {
  constructor(
    @Inject(TaskStatusCompatibilityHttpService)
    private readonly service: TaskStatusCompatibilityHttpService,
  ) {}
  @Post(":projectId/modules/:moduleId/tasks/:taskId/status")
  @Operation("transitionModuleTask")
  async transitionModuleTask(
    @Req() request: CompletionHttpRequest,
    @Res({ passthrough: true }) response: Response,
    @ContractPath("transitionModuleTask") params: unknown,
    @ContractQuery("transitionModuleTask") query: unknown,
    @ContractBody("transitionModuleTask") body: unknown,
    @ContractHeaders("transitionModuleTask") _headers: unknown,
  ) {
    const result = await this.service.handle("transitionModuleTask", {
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
