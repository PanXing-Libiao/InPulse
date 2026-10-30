import { Controller, Post, Inject, Req, Res } from "@nestjs/common";
import {
  Operation,
  ContractPath,
  ContractQuery,
  ContractBody,
  ContractHeaders,
} from "../http/contract.decorators.js";
import type { CompletionHttpRequest } from "./task-completion-http.service.js";
import { ScopeDeletionHttpService } from "./scope-deletion-http.service.js";

interface Response {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

/**
 * ADR-096 / ADR-109：模块删除的 HTTP 入口。只绑定 operationId 并转交工作流，
 * 与其它写命令共用同源、CSRF、幂等与错误体口径。
 */
@Controller("projects")
export class ScopeDeletionController {
  constructor(
    @Inject(ScopeDeletionHttpService)
    private readonly service: ScopeDeletionHttpService,
  ) {}

  @Post(":projectId/modules/:moduleId/delete")
  @Operation("deleteModule")
  async deleteModule(
    @Req() request: CompletionHttpRequest,
    @Res({ passthrough: true }) response: Response,
    @ContractPath("deleteModule") params: unknown,
    @ContractQuery("deleteModule") query: unknown,
    @ContractBody("deleteModule") body: unknown,
    @ContractHeaders("deleteModule") _headers: unknown,
  ) {
    const result = await this.service.handle("deleteModule", {
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
