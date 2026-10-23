import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import { disableFrameworkFingerprint } from "./http-security.js";
import { trustedProxySetting } from "./trusted-proxy.js";

/**
 * API JSON 请求体上限（ADR-064：与网关同为 1 MiB；20 万字符文档最坏约
 * 600 KiB，加 JSON 转义开销后仍在限内）。
 */
const JSON_BODY_LIMIT = "1mb";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  disableFrameworkFingerprint(app);
  app.useBodyParser("json", { limit: JSON_BODY_LIMIT });
  const express = app.getHttpAdapter().getInstance() as {
    set(setting: string, value: string): unknown;
  };
  express.set(
    "trust proxy",
    trustedProxySetting(process.env["TRUSTED_PROXY_CIDRS"]),
  );
  app.setGlobalPrefix("api/v1");
  const port = process.env["PORT"] ?? 3000;
  // 仅由 scripts/dev-start.mjs --lan 设置：局域网共享时 API 退回 loopback，
  // 外部流量统一经 Vite 同源代理进入，避免直接暴露 API 端口。
  const host = process.env["INPULSE_API_HOST"]?.trim();
  if (host !== undefined && host.length > 0) {
    await app.listen(port, host);
  } else {
    await app.listen(port);
  }
}

void bootstrap();
