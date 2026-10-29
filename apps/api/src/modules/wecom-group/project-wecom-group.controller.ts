import {
  Controller,
  Delete,
  Get,
  Inject,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";

import {
  ContractBody,
  ContractHeaders,
  ContractPath,
  Operation,
} from "../../http/contract.decorators.js";
import { StrictSameOriginGuard } from "../../auth/csrf.guard.js";
import {
  ProjectWecomGroupHttpService,
  type ProjectWecomGroupHttpRequest,
} from "./project-wecom-group-http.service.js";

interface ProjectWecomGroupControllerResponse {
  status(code: number): unknown;
  setHeader(name: string, value: string | readonly string[]): unknown;
}

/** ADR-106 项目企微群 Webhook HTTP 入口；只绑定 Route Registry，不直接访问数据库。 */
@Controller("projects")
export class ProjectWecomGroupController {
  constructor(
    @Inject(ProjectWecomGroupHttpService)
    private readonly service: ProjectWecomGroupHttpService,
  ) {}

  @Get(":projectId/wecom-group")
  @Operation("getProjectWecomGroup")
  async status(
    @Req() request: ProjectWecomGroupHttpRequest,
    @Res({ passthrough: true }) response: ProjectWecomGroupControllerResponse,
    @ContractPath("getProjectWecomGroup") params: unknown,
  ) {
    return this.respond("getProjectWecomGroup", request, response, params);
  }

  @Put(":projectId/wecom-group/notification-options")
  @UseGuards(StrictSameOriginGuard)
  @Operation("updateProjectWecomGroupNotificationOptions")
  async updateNotificationOptions(
    @Req() request: ProjectWecomGroupHttpRequest,
    @Res({ passthrough: true }) response: ProjectWecomGroupControllerResponse,
    @ContractPath("updateProjectWecomGroupNotificationOptions")
    params: unknown,
    @ContractBody("updateProjectWecomGroupNotificationOptions") body: unknown,
    @ContractHeaders("updateProjectWecomGroupNotificationOptions")
    _headers: unknown = undefined,
  ) {
    return this.respond(
      "updateProjectWecomGroupNotificationOptions",
      request,
      response,
      params,
      body,
    );
  }

  @Post(":projectId/wecom-group/webhooks")
  @UseGuards(StrictSameOriginGuard)
  @Operation("createProjectWecomWebhook")
  async createWebhook(
    @Req() request: ProjectWecomGroupHttpRequest,
    @Res({ passthrough: true }) response: ProjectWecomGroupControllerResponse,
    @ContractPath("createProjectWecomWebhook") params: unknown,
    @ContractBody("createProjectWecomWebhook") body: unknown,
    @ContractHeaders("createProjectWecomWebhook") _headers: unknown = undefined,
  ) {
    return this.respond(
      "createProjectWecomWebhook",
      request,
      response,
      params,
      body,
    );
  }

  @Delete(":projectId/wecom-group/webhooks/:bindingId")
  @UseGuards(StrictSameOriginGuard)
  @Operation("deleteProjectWecomWebhook")
  async deleteWebhook(
    @Req() request: ProjectWecomGroupHttpRequest,
    @Res({ passthrough: true }) response: ProjectWecomGroupControllerResponse,
    @ContractPath("deleteProjectWecomWebhook") params: unknown,
    @ContractHeaders("deleteProjectWecomWebhook") _headers: unknown = undefined,
  ) {
    return this.respond("deleteProjectWecomWebhook", request, response, params);
  }

  private async respond(
    operation: Parameters<ProjectWecomGroupHttpService["handle"]>[0],
    request: ProjectWecomGroupHttpRequest,
    response: ProjectWecomGroupControllerResponse,
    params: unknown,
    body: unknown = request.body,
  ) {
    const result = await this.service.handle(operation, {
      headers: request.headers,
      query: request.query,
      params,
      body,
    });
    response.status(result.status);
    response.setHeader("Cache-Control", "no-store");
    if (result.status >= 400) {
      const body = result.body as { readonly requestId?: string };
      if (body.requestId !== undefined) {
        response.setHeader("X-Request-Id", body.requestId);
      }
    }
    return result.body;
  }
}
