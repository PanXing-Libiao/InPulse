import type { AddressInfo } from "node:net";

import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { describe, expect, test, vi } from "vitest";

import { HealthModule } from "../src/health/health.module.js";
import { disableFrameworkFingerprint } from "../src/http-security.js";

describe("HTTP 安全响应头", () => {
  test("关闭 Express 的 X-Powered-By", () => {
    const disable = vi.fn();
    const app = { disable } as unknown as NestExpressApplication;

    disableFrameworkFingerprint(app);

    expect(disable).toHaveBeenCalledOnce();
    expect(disable).toHaveBeenCalledWith("x-powered-by");
  });

  test("真实 HTTP 响应不再包含 X-Powered-By", async () => {
    const previousDatabaseUrl = process.env["DATABASE_URL"];
    process.env["DATABASE_URL"] = "postgresql://127.0.0.1:1/app";
    const app = await NestFactory.create<NestExpressApplication>(HealthModule, {
      logger: false,
    });
    disableFrameworkFingerprint(app);
    await app.listen(0, "127.0.0.1");

    try {
      const address = app.getHttpServer().address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${address.port}/health/live`,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("x-powered-by")).toBeNull();
    } finally {
      await app.close();
      if (previousDatabaseUrl === undefined) {
        delete process.env["DATABASE_URL"];
      } else {
        process.env["DATABASE_URL"] = previousDatabaseUrl;
      }
    }
  });
});
