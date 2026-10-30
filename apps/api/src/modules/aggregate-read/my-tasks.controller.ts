import { randomUUID } from "node:crypto";

import { Controller, Get, Req, Res } from "@nestjs/common";

import type { MyTaskPage, MyTasksQueryRequest } from "@inpulse/api-contract";

import { SessionAuthService } from "../../auth/session-auth.service.js";
import { getHeader, type HttpHeaderBag } from "../../auth/csrf.http.js";
import { ContractQuery, Operation } from "../../http/contract.decorators.js";
import { AggregateReadError } from "./aggregate-read.errors.js";
import { MyTasksQueryService } from "./my-tasks-query.service.js";

interface MyTasksControllerRequest {
  readonly headers: HttpHeaderBag;
}

interface MyTasksControllerResponse {
  status(code: number): unknown;
}

interface ErrorResponseDto {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, string>>;
  readonly requestId: string;
}

/**
 * F-32 我的任务（R-3）。只绑定 listMyTasks；负责人固定为当前 Session 用户，
 * 不接受任何他人身份参数，projectId 只用于缩小服务端授权范围。
 * 游标无效、过期或与筛选不匹配统一 422。
 */
@Controller("me")
export class MyTasksController {
  constructor(
    private readonly sessionAuth: SessionAuthService,
    private readonly myTasks: MyTasksQueryService,
  ) {}

  @Get("tasks")
  @Operation("listMyTasks")
  async listMyTasks(
    @Req() request: MyTasksControllerRequest,
    @Res({ passthrough: true }) response: MyTasksControllerResponse,
    @ContractQuery("listMyTasks") query: MyTasksQueryRequest,
  ): Promise<MyTaskPage | ErrorResponseDto> {
    const requestId = randomUUID();
    const actor = await this.sessionAuth.resolveActor(
      getHeader(request.headers, "cookie"),
    );
    if (actor === undefined) {
      response.status(401);
      return {
        code: "MY_TASKS_UNAUTHENTICATED",
        message: "需要有效认证 Session 才能查看我的任务",
        details: {},
        requestId,
      };
    }

    try {
      return await this.myTasks.list({
        actorUserId: actor.userId,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.projectId === undefined
          ? {}
          : { projectId: query.projectId }),
        ...(query.ownership === undefined
          ? {}
          : { ownership: query.ownership }),
        ...(query.workStatus === undefined
          ? {}
          : { workStatus: query.workStatus }),
        ...(query.hasPublishedRecord === undefined
          ? {}
          : { hasPublishedRecord: query.hasPublishedRecord }),
        ...(query.priority === undefined ? {} : { priority: query.priority }),
        ...(query.includeCanceled === undefined
          ? {}
          : { includeCanceled: query.includeCanceled }),
        ...(query.todayTodo === undefined
          ? {}
          : { todayTodo: query.todayTodo }),
      });
    } catch (error) {
      if (error instanceof AggregateReadError) {
        response.status(error.status);
        return {
          code: error.code,
          message: error.message,
          details: {},
          requestId,
        };
      }
      response.status(500);
      return {
        code: "INTERNAL_ERROR",
        message: "服务器无法完成我的任务查询",
        details: {},
        requestId,
      };
    }
  }
}
