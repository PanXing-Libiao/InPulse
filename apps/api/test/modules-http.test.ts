import { describe, expect, it, vi } from "vitest";
import type { TransactionContext } from "../src/database/transaction-context.js";
import type { SessionAuthService } from "../src/auth/session-auth.service.js";
import type { AuthenticatedMutationService } from "../src/auth/authenticated-mutation.service.js";
import type {
  IdempotencyHttpService,
  IdempotencyHttpCommand,
} from "../src/idempotency/http-service.js";
import type { ModulesManagementService } from "../src/modules/modules/modules-management.service.js";
import { ModulesHttpService } from "../src/modules/modules/modules-http.service.js";

const tx = {} as TransactionContext;
const item = {
  id: 3,
  projectId: 2,
  code: "INP-M-1",
  name: "模块",
  description: "",
  kind: "NORMAL",
  sortOrder: 0,
  rowVersion: 1,
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
  stats: { openTaskCount: 0, completedTaskCount: 0 },
};
function setup() {
  const resolveActor = vi.fn().mockResolvedValue({ userId: 7 });
  const verify = vi.fn().mockResolvedValue({ userId: 7 });
  const authorize = vi.fn().mockResolvedValue(undefined);
  const replay = vi.fn().mockResolvedValue(undefined);
  const execute = vi.fn().mockResolvedValue(item);
  const list = vi.fn().mockResolvedValue({ items: [item] });
  let command: IdempotencyHttpCommand | undefined;
  const run = vi.fn(async (input: IdempotencyHttpCommand) => {
    command = input;
    const actorId =
      typeof input.actorId === "number"
        ? input.actorId
        : await input.actorId(tx);
    return input.execute(tx, actorId);
  });
  const service = new ModulesHttpService(
    { resolveActor } as unknown as SessionAuthService,
    { verify } as unknown as AuthenticatedMutationService,
    { run } as unknown as IdempotencyHttpService,
    { list, authorize, replay, execute } as unknown as ModulesManagementService,
  );
  const request = {
    headers: {
      host: "localhost",
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "x-csrf-token": "a".repeat(43),
      "if-match": '"1"',
      "idempotency-key": "request-for-modules",
    },
    params: { projectId: "2", moduleId: "3" },
    query: {},
    body: { name: "  模块  " },
  };
  return {
    service,
    request,
    verify,
    authorize,
    execute,
    list,
    replay,
    resolveActor,
    run,
    command: () => command!,
  };
}
describe("F-12 HTTP orchestration", () => {
  it("passes parsed inputs to digest and uses the same transaction for authorization and execution", async () => {
    const s = setup();
    const result = await s.service.handle("updateModule", s.request);
    expect(result.status).toBe(200);
    expect(s.command().request.body).toEqual({ name: "模块", description: "" });
    expect(s.verify).toHaveBeenCalledWith(tx, s.request.headers);
    expect(s.authorize).toHaveBeenCalledWith(tx, 7, 2, 3);
    expect(s.execute).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ actorId: 7, moduleId: 3, version: 1 }),
    );
  });
  it("rejects unauthenticated reads and invalid fields without executing business writes", async () => {
    const s = setup();
    s.resolveActor.mockResolvedValue(undefined);
    expect((await s.service.handle("listModules", s.request)).status).toBe(401);
    expect(
      (
        await s.service.handle("updateModule", {
          ...s.request,
          body: { name: " ", kind: "NORMAL" },
        })
      ).status,
    ).toBe(422);
    expect(s.execute).not.toHaveBeenCalled();
  });
  it("revalidates membership on replay and refuses cached response disclosure", async () => {
    const s = setup();
    const result = await s.service.handle("updateModule", s.request);
    expect(result.status).toBe(200);
    // ADR-044：模块命令对项目内活跃成员开放，回放时重新鉴权失败即 404。
    s.replay.mockRejectedValueOnce({ code: "PROJECT_NOT_FOUND" });
    await expect(
      s.command().replayAuthorizer!(
        { replayAuthContext: { projectId: 2, moduleId: 3 } } as never,
        tx,
      ),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect(s.replay).toHaveBeenCalledWith(tx, 7, {
      projectId: 2,
      moduleId: 3,
    });
  });
  it("normalizes name conflicts and never exposes database failures", async () => {
    const s = setup();
    s.execute.mockRejectedValueOnce({
      code: "23505",
      constraint_name: "modules_name_project_unique",
      detail: "sensitive row",
    });
    expect(await s.service.handle("updateModule", s.request)).toMatchObject({
      status: 409,
      body: { code: "MODULE_NAME_CONFLICT" },
    });
    s.execute.mockRejectedValueOnce(new Error("SELECT secret"));
    const error = await s.service.handle("updateModule", s.request);
    expect(error.status).toBe(500);
    expect(JSON.stringify(error)).not.toContain("secret");
  });
  it("rejects response schema drift instead of returning internal fields", async () => {
    const s = setup();
    s.execute.mockResolvedValueOnce({ ...item, internal: "hidden" });
    const result = await s.service.handle("updateModule", s.request);
    expect(result.status).toBe(500);
    expect(JSON.stringify(result)).not.toContain("hidden");
  });
});
