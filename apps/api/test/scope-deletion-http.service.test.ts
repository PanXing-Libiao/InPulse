import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedMutationService } from "../src/auth/authenticated-mutation.service.js";
import type { TransactionContext } from "../src/database/transaction-context.js";
import {
  IdempotencyHttpError,
  IdempotencyHttpService,
} from "../src/idempotency/http-service.js";
import type {
  IdempotencyRunner,
  RunIdempotencyCommand,
} from "../src/idempotency/runner.js";
import { resolveRegisteredRoute } from "../src/idempotency/route.js";
import type { IdempotencyRecord } from "../src/idempotency/store.js";
import { featureDeletionForbidden } from "../src/modules/features/feature-deletion.command-port.js";
import { moduleUnclassifiedProtected } from "../src/modules/modules/module-deletion.command-port.js";
import { ProjectCapabilityAccessError } from "../src/modules/projects/project-member-permission-policy.service.js";
import type { ProjectRoleGateService } from "../src/modules/projects/project-role-gate.service.js";
import { ScopeDeletionHttpService } from "../src/workflows/scope-deletion-http.service.js";
import type { ScopeDeletionWorkflow } from "../src/workflows/scope-deletion.workflow.js";

const tx = {} as TransactionContext;
const key = randomBytes(32);
const moduleBody = {
  id: 9,
  projectId: 3,
  code: "PAY-M-2",
  name: "结算模块",
  kind: "NORMAL" as const,
  deletedFeatureCount: 2,
  deletedTaskCount: 3,
  deletedRecordCount: 2,
  removedLinkCount: 2,
};
const featureBody = {
  id: 11,
  projectId: 3,
  moduleId: 9,
  code: "PAY-F-4",
  name: "对账功能",
  deletedTaskCount: 1,
  deletedRecordCount: 1,
  removedLinkCount: 1,
};

function request(
  overrides: {
    headers?: Record<string, string>;
    params?: Record<string, string>;
    query?: Record<string, unknown>;
    body?: unknown;
  } = {},
) {
  return {
    headers: {
      host: "localhost",
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
      cookie: "__Host-session=x",
      "x-csrf-token": "c".repeat(43),
      "idempotency-key": "f27-unit-key-0001",
      "content-type": "application/json",
      "if-match": '"4"',
      ...overrides.headers,
    },
    params: overrides.params ?? { projectId: "3", moduleId: "9" },
    query: overrides.query ?? {},
    body:
      overrides.body === undefined ? { reason: "模块下线" } : overrides.body,
  };
}

function setup(
  options: {
    actorId?: number | undefined;
    failWith?: unknown;
    moduleResult?: unknown;
    featureResult?: unknown;
    replay?: boolean;
    replayRole?: string;
  } = {},
) {
  const verify = vi
    .fn()
    .mockResolvedValue(
      options.actorId === undefined ? undefined : { userId: options.actorId },
    );
  const results: unknown[] = [];
  const deleteModule = vi.fn(async () => {
    if (options.failWith !== undefined) throw options.failWith;
    return options.moduleResult ?? moduleBody;
  });
  const deleteFeature = vi.fn(async () => {
    if (options.failWith !== undefined) throw options.failWith;
    return options.featureResult ?? featureBody;
  });
  const scopeDeleterReplayRole = vi
    .fn()
    .mockResolvedValue(options.replayRole ?? "LEADER");
  const runnerRun = vi.fn(async (input: RunIdempotencyCommand) => {
    if (options.replay === true) {
      // 已存记录必须是合法可重放的 2xx，否则失败原因会变成响应策略错误。
      const isModule = input.command.operationId === "deleteModule";
      const saved = {
        responseStatus: 200,
        responseSchemaRef: isModule
          ? "ModuleDeletionResponse"
          : "FeatureDeletionResponse",
        responseHasBody: true,
        responseBody: isModule ? moduleBody : featureBody,
        replayAuthContext: isModule
          ? { projectId: 3, moduleId: 9 }
          : { projectId: 3, moduleId: 9, featureId: 11 },
      } as unknown as IdempotencyRecord;
      await input.replayAuthorizer?.(saved, tx);
      return { kind: "replayed" as const, record: saved };
    }
    const actorId =
      typeof input.actorId === "number"
        ? input.actorId
        : await input.actorId(tx);
    const result = await input.execute(tx, actorId);
    results.push(result);
    return {
      kind: "executed" as const,
      record: {
        responseStatus: result.responseStatus,
        responseSchemaRef: result.responseSchemaRef,
        responseHasBody: result.responseHasBody,
        responseBody: result.responseBody,
      },
    };
  });
  const service = new ScopeDeletionHttpService(
    { verify } as unknown as AuthenticatedMutationService,
    new IdempotencyHttpService(
      { run: runnerRun } as unknown as IdempotencyRunner,
      { currentVersion: 1, currentKey: () => key, keyFor: () => key },
      resolveRegisteredRoute,
    ),
    { deleteModule, deleteFeature } as unknown as ScopeDeletionWorkflow,
    { scopeDeleterReplayRole } as unknown as ProjectRoleGateService,
  );
  return {
    service,
    verify,
    deleteModule,
    deleteFeature,
    scopeDeleterReplayRole,
    results,
    runnerRun,
  };
}

describe("ADR-096 物理删除模块/功能 HTTP 边界", () => {
  it("合法请求返回 200 并校验契约 DTO，业务命令收到认证用户", async () => {
    const { service, deleteModule } = setup({ actorId: 7 });
    const result = await service.handle("deleteModule", request());
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      id: 9,
      kind: "NORMAL",
      deletedFeatureCount: 2,
      removedLinkCount: 2,
    });
    expect(deleteModule).toHaveBeenCalledTimes(1);
    // 参数顺序：actorId、projectId、moduleId、If-Match 版本、原因、requestId。
    expect(deleteModule.mock.calls[0]?.slice(0, 5)).toEqual([
      7,
      3,
      9,
      4,
      "模块下线",
    ]);
  });

  it("重放授权上下文登记项目与模块，功能删除追加 featureId", async () => {
    const { service, results } = setup({ actorId: 7 });
    await service.handle("deleteModule", request());
    expect(results[0]).toMatchObject({
      responseSchemaRef: "ModuleDeletionResponse",
      replayAuthContext: { projectId: 3, moduleId: 9 },
    });
    await service.handle(
      "deleteFeature",
      request({
        params: { projectId: "3", moduleId: "9", featureId: "11" },
        body: { reason: "功能下线" },
      }),
    );
    expect(results[1]).toMatchObject({
      responseSchemaRef: "FeatureDeletionResponse",
      replayAuthContext: { projectId: 3, moduleId: 9, featureId: 11 },
    });
  });

  it("同源校验失败返回 403 且不进入幂等与业务层", async () => {
    const { service, runnerRun, deleteModule } = setup({ actorId: 7 });
    const result = await service.handle(
      "deleteModule",
      request({ headers: { origin: "https://evil.example" } }),
    );
    expect(result).toMatchObject({ status: 403 });
    expect(result.body).toMatchObject({ code: "CSRF_ORIGIN_REJECTED" });
    expect(runnerRun).not.toHaveBeenCalled();
    expect(deleteModule).not.toHaveBeenCalled();
  });

  it("非 JSON 请求体返回 400 契约错误码", async () => {
    const { service, deleteFeature } = setup({ actorId: 7 });
    const result = await service.handle(
      "deleteFeature",
      request({
        params: { projectId: "3", moduleId: "9", featureId: "11" },
        headers: { "content-type": "text/plain" },
      }),
    );
    expect(result).toMatchObject({ status: 400 });
    expect(result.body).toMatchObject({
      code: "FEATURE_CONTENT_TYPE_INVALID",
    });
    expect(deleteFeature).not.toHaveBeenCalled();
  });

  it("请求头、路径、请求体与查询参数违反契约统一返回 422", async () => {
    const { service, deleteModule } = setup({ actorId: 7 });
    const badHeader = await service.handle(
      "deleteModule",
      request({ headers: { "x-csrf-token": "" } }),
    );
    expect(badHeader).toMatchObject({ status: 422 });
    expect(badHeader.body).toMatchObject({
      code: "MODULE_VALIDATION_FAILED",
      details: {},
    });
    const badVersion = await service.handle(
      "deleteModule",
      request({ headers: { "if-match": "4" } }),
    );
    expect(badVersion).toMatchObject({ status: 422 });
    const badPath = await service.handle(
      "deleteModule",
      request({ params: { projectId: "0", moduleId: "9" } }),
    );
    expect(badPath).toMatchObject({ status: 422 });
    const emptyReason = await service.handle(
      "deleteModule",
      request({ body: { reason: "   " } }),
    );
    expect(emptyReason).toMatchObject({ status: 422 });
    const withQuery = await service.handle(
      "deleteModule",
      request({ query: { dryRun: "1" } }),
    );
    expect(withQuery).toMatchObject({
      status: 422,
      body: { code: "MODULE_VALIDATION_FAILED", details: {} },
    });
    expect(deleteModule).not.toHaveBeenCalled();
  });

  it("幂等键缺失或过短返回 400", async () => {
    const { service } = setup({ actorId: 7 });
    const missing = await service.handle(
      "deleteModule",
      request({ headers: { "idempotency-key": "" } }),
    );
    expect(missing).toMatchObject({ status: 400 });
    expect(missing.body).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    const short = await service.handle(
      "deleteModule",
      request({ headers: { "idempotency-key": "short" } }),
    );
    expect(short).toMatchObject({ status: 400 });
    expect(short.body).toMatchObject({ code: "IDEMPOTENCY_KEY_INVALID" });
  });

  it("匿名或 CSRF 失效返回 401 且不写入业务", async () => {
    const { service, deleteModule } = setup();
    const result = await service.handle("deleteModule", request());
    expect(result).toMatchObject({ status: 401 });
    expect(result.body).toMatchObject({
      code: "MODULE_SESSION_REQUIRED",
    });
    expect(deleteModule).not.toHaveBeenCalled();
  });

  it("业务层显式错误按状态码直通并保留服务端理由", async () => {
    const { service } = setup({
      actorId: 7,
      failWith: moduleUnclassifiedProtected(),
    });
    const result = await service.handle("deleteModule", request());
    expect(result).toMatchObject({ status: 409 });
    expect(result.body).toMatchObject({
      code: "MODULE_UNCLASSIFIED_PROTECTED",
      message: "未分类模块不能删除",
    });
  });

  it("幂等冲突错误按 409 返回", async () => {
    const { service } = setup({
      actorId: 7,
      failWith: new IdempotencyHttpError(
        409,
        "IDEMPOTENCY_REQUEST_MISMATCH",
        "相同 Idempotency-Key 对应不同请求内容",
      ),
    });
    const result = await service.handle("deleteModule", request());
    expect(result).toMatchObject({ status: 409 });
    expect(result.body).toMatchObject({
      code: "IDEMPOTENCY_REQUEST_MISMATCH",
    });
  });

  it("未预期错误收敛为 500 且不泄露内部细节", async () => {
    const { service } = setup({
      actorId: 7,
      failWith: new Error("relation app.modules does not exist"),
    });
    const result = await service.handle(
      "deleteFeature",
      request({
        params: { projectId: "3", moduleId: "9", featureId: "11" },
        body: { reason: "功能下线" },
      }),
    );
    expect(result).toMatchObject({ status: 500 });
    expect(result.body).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "暂时无法删除功能",
      details: {},
    });
    expect(JSON.stringify(result.body)).not.toMatch(/relation app\./);
  });

  it("重放只复核实时角色：组长与系统管理员放行、降级成员 403、已移除 404", async () => {
    const leader = setup({ actorId: 7, replay: true, replayRole: "LEADER" });
    const leaderResult = await leader.service.handle("deleteModule", request());
    expect(leaderResult.status).toBe(200);
    expect(leaderResult.body).toMatchObject({ id: 9, removedLinkCount: 2 });
    expect(leader.deleteModule).not.toHaveBeenCalled();

    const admin = setup({
      actorId: 7,
      replay: true,
      replayRole: "SYSTEM_ADMIN",
    });
    expect((await admin.service.handle("deleteModule", request())).status).toBe(
      200,
    );

    const member = setup({ actorId: 7, replay: true, replayRole: "MEMBER" });
    member.scopeDeleterReplayRole.mockRejectedValueOnce(
      new ProjectCapabilityAccessError(
        403,
        "MODULE_DELETE_FORBIDDEN",
        "当前平台权限配置不允许该成员删除模块或功能",
        "moduleFeatureDelete",
      ),
    );
    const memberFailure = await member.service.handle(
      "deleteModule",
      request(),
    );
    expect(memberFailure).toMatchObject({ status: 403 });
    expect(memberFailure.body).toMatchObject({
      code: "MODULE_DELETE_FORBIDDEN",
    });
    // 不得泄露已存状态码与响应体。
    expect(JSON.stringify(memberFailure.body)).not.toMatch(
      /deletedFeatureCount/,
    );

    const outsider = setup({
      actorId: 7,
      replay: true,
      replayRole: "NOT_MEMBER",
    });
    const outsiderFailure = await outsider.service.handle(
      "deleteModule",
      request(),
    );
    expect(outsiderFailure).toMatchObject({ status: 404 });
    expect(outsiderFailure.body).toMatchObject({ code: "MODULE_NOT_FOUND" });
  });

  it("重放上下文与请求路径不一致时拒绝，未认证重放返回 401", async () => {
    const mismatched = setup({
      actorId: 7,
      replay: true,
      replayRole: "LEADER",
    });
    const mismatch = await mismatched.service.handle(
      "deleteModule",
      request({ params: { projectId: "3", moduleId: "99" } }),
    );
    expect(mismatch).toMatchObject({ status: 404 });
    expect(mismatch.body).toMatchObject({ code: "MODULE_NOT_FOUND" });

    const anonymous = setup({ replay: true, replayRole: "LEADER" });
    const anonymousResult = await anonymous.service.handle(
      "deleteModule",
      request(),
    );
    expect(anonymousResult).toMatchObject({ status: 401 });
    expect(anonymousResult.body).toMatchObject({
      code: "MODULE_SESSION_REQUIRED",
    });
  });

  it("功能侧失败按功能错误码返回，不与模块错误码串用", async () => {
    const forbidden = setup({
      actorId: 7,
      failWith: featureDeletionForbidden(),
    });
    const forbiddenResult = await forbidden.service.handle(
      "deleteFeature",
      request({
        params: { projectId: "3", moduleId: "9", featureId: "11" },
      }),
    );
    expect(forbiddenResult).toMatchObject({ status: 403 });
    expect(forbiddenResult.body).toMatchObject({
      code: "FEATURE_DELETE_FORBIDDEN",
      message: "只有系统管理员或本项目组长可以删除功能",
    });
  });
});
