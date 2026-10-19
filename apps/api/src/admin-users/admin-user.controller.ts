import { Controller, Get, Inject, Patch, Post, Req, Res } from "@nestjs/common";

import { Operation } from "../http/contract.decorators.js";
import {
  AdminUsersHttpService,
  type AdminUsersHttpRequest,
} from "./admin-user-http.service.js";

interface AdminUsersControllerResponse {
  readonly status: (code: number) => unknown;
  readonly setHeader: (name: string, value: string) => unknown;
}

/** F-03 用户管理 HTTP 入口；只绑定 Route Registry，不直接访问数据库。 */
@Controller("admin/users")
export class AdminUsersController {
  constructor(
    @Inject(AdminUsersHttpService)
    private readonly service: AdminUsersHttpService,
  ) {}

  @Get()
  @Operation("listAdminUsers")
  async list(
    @Req() request: AdminUsersHttpRequest,
    @Res({ passthrough: true }) response: AdminUsersControllerResponse,
  ) {
    return this.respond("listAdminUsers", request, response);
  }

  @Get(":userId/offboarding")
  @Operation("getAdminUserOffboarding")
  async offboarding(
    @Req() request: AdminUsersHttpRequest,
    @Res({ passthrough: true }) response: AdminUsersControllerResponse,
  ) {
    return this.respond("getAdminUserOffboarding", request, response);
  }

  @Post()
  @Operation("createUser")
  async create(
    @Req() request: AdminUsersHttpRequest,
    @Res({ passthrough: true }) response: AdminUsersControllerResponse,
  ) {
    return this.respond("createUser", request, response);
  }

  @Patch(":userId")
  @Operation("updateUser")
  async update(
    @Req() request: AdminUsersHttpRequest,
    @Res({ passthrough: true }) response: AdminUsersControllerResponse,
  ) {
    return this.respond("updateUser", request, response);
  }

  @Post(":userId/disable")
  @Operation("disableUser")
  async disable(
    @Req() request: AdminUsersHttpRequest,
    @Res({ passthrough: true }) response: AdminUsersControllerResponse,
  ) {
    return this.respond("disableUser", request, response);
  }

  @Post(":userId/enable")
  @Operation("enableUser")
  async enable(
    @Req() request: AdminUsersHttpRequest,
    @Res({ passthrough: true }) response: AdminUsersControllerResponse,
  ) {
    return this.respond("enableUser", request, response);
  }

  @Post(":userId/delete")
  @Operation("deleteUser")
  async remove(
    @Req() request: AdminUsersHttpRequest,
    @Res({ passthrough: true }) response: AdminUsersControllerResponse,
  ) {
    return this.respond("deleteUser", request, response);
  }

  @Post(":userId/force-logout")
  @Operation("forceLogoutUser")
  async forceLogout(
    @Req() request: AdminUsersHttpRequest,
    @Res({ passthrough: true }) response: AdminUsersControllerResponse,
  ) {
    return this.respond("forceLogoutUser", request, response);
  }

  private async respond(
    operation: Parameters<AdminUsersHttpService["handle"]>[0],
    request: AdminUsersHttpRequest,
    response: AdminUsersControllerResponse,
  ) {
    const result = await this.service.handle(operation, request);
    response.status(result.status);
    response.setHeader("Cache-Control", "no-store");
    return result.body;
  }
}
