import { randomUUID } from "node:crypto";

import { Controller, Get, Req, Res } from "@nestjs/common";

import {
  searchEntityTypeSchema,
  type SearchItem,
  type SearchQueryRequest,
  type SearchPage,
} from "@inpulse/api-contract";
import { ContractQuery, Operation } from "../../http/contract.decorators.js";
import { SessionAuthService } from "../../auth/session-auth.service.js";
import { getHeader, type HttpHeaderBag } from "../../auth/csrf.http.js";
import {
  SearchAuthorizationError,
  SearchQueryService,
  SearchQueryValidationError,
} from "./search-query.service.js";
import type { SearchProjectionItem } from "./search-projection.reader.js";

interface SearchControllerRequest {
  readonly headers: HttpHeaderBag;
}

interface SearchControllerResponse {
  status(code: number): unknown;
}

interface ErrorResponseDto {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, string>>;
  readonly requestId: string;
}

function toSearchItem(item: SearchProjectionItem): SearchItem {
  return {
    projectId: item.projectId,
    entityType: searchEntityTypeSchema.parse(item.entityType),
    entityId: item.entityId,
    moduleId: item.moduleId,
    recordId: item.recordId,
    title: item.title,
    summary: item.summary,
  };
}

/**
 * F-26 全局搜索入口：只绑定 Route Registry 中的 getSearch，执行服务端
 * Session 解析与 AuthorizedProjectScope 查询，不接收或回传权限范围。
 */
@Controller("search")
export class SearchController {
  constructor(
    private readonly sessionAuth: SessionAuthService,
    private readonly searchService: SearchQueryService,
  ) {}

  @Get()
  @Operation("getSearch")
  async search(
    @Req() request: SearchControllerRequest,
    @Res({ passthrough: true }) response: SearchControllerResponse,
    @ContractQuery("getSearch") query: SearchQueryRequest,
  ): Promise<SearchPage | ErrorResponseDto> {
    const requestId = randomUUID();
    const actor = await this.sessionAuth.resolveActor(
      getHeader(request.headers, "cookie"),
    );
    if (actor === undefined) {
      response.status(401);
      return {
        code: "SEARCH_UNAUTHENTICATED",
        message: "需要有效认证 Session 才能执行全局搜索",
        details: {},
        requestId,
      };
    }

    try {
      const result = await this.searchService.search({
        actorUserId: actor.userId,
        query: query.q,
        ...(query.cursor === undefined ? {} : { after: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.includeVoid === undefined
          ? {}
          : { includeVoid: query.includeVoid }),
      });
      return {
        items: result.items.map(toSearchItem),
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      };
    } catch (error) {
      if (error instanceof SearchQueryValidationError) {
        response.status(422);
        return {
          code: "VALIDATION_FAILED",
          message: error.message,
          details: { reason: error.status },
          requestId,
        };
      }
      if (error instanceof SearchAuthorizationError) {
        response.status(401);
        return {
          code: "SEARCH_AUTHORIZATION_FAILED",
          message: "搜索授权范围无效",
          details: {},
          requestId,
        };
      }
      response.status(500);
      return {
        code: "INTERNAL_ERROR",
        message: "服务器无法完成全局搜索",
        details: {},
        requestId,
      };
    }
  }
}
