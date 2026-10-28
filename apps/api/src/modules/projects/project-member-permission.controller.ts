import {
  Controller,
  Get,
  Inject,
  Put,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";

import { StrictSameOriginGuard } from "../../auth/csrf.guard.js";
import { ContractHeaders, Operation } from "../../http/contract.decorators.js";
import {
  ProjectMemberPermissionHttpService,
  type ProjectMemberPermissionHttpRequest,
} from "./project-member-permission-http.service.js";

interface ProjectMemberPermissionControllerResponse {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

/** ADR-104 全平台项目成员权限配置入口；只绑定 Route Registry。 */
@Controller("project-member-permissions")
export class ProjectMemberPermissionController {
  constructor(
    @Inject(ProjectMemberPermissionHttpService)
    private readonly service: ProjectMemberPermissionHttpService,
  ) {}

  @Get()
  @Operation("getProjectMemberPermissions")
  async get(
    @Req() request: ProjectMemberPermissionHttpRequest,
    @Res({ passthrough: true })
    response: ProjectMemberPermissionControllerResponse,
  ) {
    return this.respond(await this.service.get(request), response);
  }

  @Put()
  @UseGuards(StrictSameOriginGuard)
  @Operation("updateProjectMemberPermissions")
  async update(
    @Req() request: ProjectMemberPermissionHttpRequest,
    @Res({ passthrough: true })
    response: ProjectMemberPermissionControllerResponse,
    @ContractHeaders("updateProjectMemberPermissions") _headers: unknown,
  ) {
    return this.respond(await this.service.update(request), response);
  }

  private respond(
    result: { readonly status: number; readonly body: unknown },
    response: ProjectMemberPermissionControllerResponse,
  ): unknown {
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
