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

/** ADR-077 项目企微群绑定 HTTP 入口；只绑定 Route Registry，不直接访问数据库。 */
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

  @Post(":projectId/wecom-group/codes")
  @UseGuards(StrictSameOriginGuard)
  @Operation("createProjectWecomGroupCode")
  async createCode(
    @Req() request: ProjectWecomGroupHttpRequest,
    @Res({ passthrough: true }) response: ProjectWecomGroupControllerResponse,
    @ContractPath("createProjectWecomGroupCode") params: unknown,
    @ContractHeaders("createProjectWecomGroupCode")
    _headers: unknown = undefined,
  ) {
    return this.respond(
      "createProjectWecomGroupCode",
      request,
      response,
      params,
    );
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

  @Delete(":projectId/wecom-group")
  @UseGuards(StrictSameOriginGuard)
  @Operation("deleteProjectWecomGroup")
  async unbind(
    @Req() request: ProjectWecomGroupHttpRequest,
    @Res({ passthrough: true }) response: ProjectWecomGroupControllerResponse,
    @ContractPath("deleteProjectWecomGroup") params: unknown,
    @ContractHeaders("deleteProjectWecomGroup") _headers: unknown = undefined,
  ) {
    return this.respond("deleteProjectWecomGroup", request, response, params);
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
