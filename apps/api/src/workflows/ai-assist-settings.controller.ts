import { Controller, Get, Inject, Post, Put, Req, Res } from "@nestjs/common";

import { Operation } from "../http/contract.decorators.js";
import {
  AiAssistSettingsHttpService,
  type AiAssistSettingsHttpRequest,
} from "./ai-assist-settings-http.service.js";

interface AiAssistSettingsControllerResponse {
  readonly status: (code: number) => unknown;
  readonly setHeader: (name: string, value: string) => unknown;
}

/** ADR-068 AI 辅助转换管理员配置 HTTP 入口；只绑定 Route Registry。 */
@Controller("admin/ai-assist")
export class AiAssistSettingsController {
  constructor(
    @Inject(AiAssistSettingsHttpService)
    private readonly service: AiAssistSettingsHttpService,
  ) {}

  @Get()
  @Operation("getAiAssistSettings")
  async get(
    @Req() request: AiAssistSettingsHttpRequest,
    @Res({ passthrough: true }) response: AiAssistSettingsControllerResponse,
  ) {
    return this.respond("getAiAssistSettings", request, response);
  }

  @Put()
  @Operation("updateAiAssistSettings")
  async update(
    @Req() request: AiAssistSettingsHttpRequest,
    @Res({ passthrough: true }) response: AiAssistSettingsControllerResponse,
  ) {
    return this.respond("updateAiAssistSettings", request, response);
  }

  @Post("models")
  @Operation("listAiAssistModels")
  async listModels(
    @Req() request: AiAssistSettingsHttpRequest,
    @Res({ passthrough: true }) response: AiAssistSettingsControllerResponse,
  ) {
    return this.respond("listAiAssistModels", request, response);
  }

  @Post("test")
  @Operation("testAiAssistSettings")
  async test(
    @Req() request: AiAssistSettingsHttpRequest,
    @Res({ passthrough: true }) response: AiAssistSettingsControllerResponse,
  ) {
    return this.respond("testAiAssistSettings", request, response);
  }

  private async respond(
    operation: Parameters<AiAssistSettingsHttpService["handle"]>[0],
    request: AiAssistSettingsHttpRequest,
    response: AiAssistSettingsControllerResponse,
  ) {
    const result = await this.service.handle(operation, request);
    response.status(result.status);
    response.setHeader("Cache-Control", "no-store");
    return result.body;
  }
}
