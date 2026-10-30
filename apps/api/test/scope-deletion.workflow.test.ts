import { describe, expect, it, vi } from "vitest";
import type { TransactionContext } from "../src/database/transaction-context.js";
import { ModuleDeletionError } from "../src/modules/modules/module-deletion.command-port.js";
import { ScopeDeletionWorkflow } from "../src/workflows/scope-deletion.workflow.js";

/**
 * ADR-096 / ADR-109：模块删除 Workflow 只负责门禁、调用数据库窄口函数、追加一条
 * 顶层审计与项目动态。真实级联范围由 scopedeletion 的 PostgreSQL 集成测试覆盖。
 */
const moduleRow = {
  id: 9,
  projectId: 3,
  code: "PAY-M-2",
  name: "结算模块",
  kind: "NORMAL" as const,
  rowVersion: 4,
};

const deletedModule = {
  ...moduleRow,
  deletedAt: "2026-10-23T00:00:00.000Z",
  deletedTaskCount: 3,
  deletedRecordCount: 4,
  removedLinkCount: 5,
};

function harness() {
  const tx = {} as TransactionContext;
  const order: string[] = [];
  const values = {
    projectWritable: true,
    module: moduleRow as typeof moduleRow | null,
    moduleKind: "NORMAL" as "NORMAL" | "UNCLASSIFIED",
    moduleHardDeleteResult: deletedModule as typeof deletedModule | undefined,
  };
  const step = (label: string, value: unknown): Promise<unknown> => {
    order.push(label);
    return Promise.resolve(value);
  };
  const deps = {
    uow: {
      run: vi.fn(
        async (fn: (context: TransactionContext) => Promise<unknown>) => fn(tx),
      ),
    },
    access: {
      checkProjectForWrite: vi.fn(async (..._args: unknown[]) =>
        step(
          "lock-project",
          values.projectWritable
            ? { kind: "allowed", resource: {} }
            : { kind: "not-found" },
        ),
      ),
    },
    modules: {
      authorize: vi.fn(async (..._args: unknown[]) =>
        step("authorize-module", undefined),
      ),
      findForDeletion: vi.fn(async (..._args: unknown[]) =>
        step(
          "find-module",
          values.module === null
            ? null
            : { ...values.module, kind: values.moduleKind },
        ),
      ),
      hardDelete: vi.fn(async (..._args: unknown[]) =>
        step("hard-delete-module", values.moduleHardDeleteResult),
      ),
    },
    audit: {
      append: vi.fn(async (..._args: unknown[]) =>
        step("audit", { chainId: "PROJECT:3", sequenceNo: 12 }),
      ),
    },
    activity: {
      append: vi.fn(async (..._args: unknown[]) => step("activity", undefined)),
      updateEntityVisibility: vi.fn(async (..._args: unknown[]) =>
        step("visibility", undefined),
      ),
    },
    tx,
    order,
    values,
  };
  const workflow = new ScopeDeletionWorkflow(
    deps.uow as never,
    deps.access as never,
    deps.modules as never,
    deps.audit as never,
    deps.activity as never,
  );
  return { ...deps, workflow };
}

const deleteModule = (harnessed: ReturnType<typeof harness>) =>
  harnessed.workflow.deleteModule(7, 3, 9, 4, "模块下线", "req-1");

describe("ADR-096 物理删除模块的跨域编排", () => {
  it("未分类模块在物理删除前被拒绝", async () => {
    const harnessed = harness();
    harnessed.values.moduleKind = "UNCLASSIFIED";

    const error = await deleteModule(harnessed).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ModuleDeletionError);
    expect(error).toMatchObject({
      status: 409,
      code: "MODULE_UNCLASSIFIED_PROTECTED",
    });
    expect(harnessed.order).toEqual([
      "authorize-module",
      "lock-project",
      "find-module",
    ]);
    expect(harnessed.modules.hardDelete).not.toHaveBeenCalled();
    expect(harnessed.audit.append).not.toHaveBeenCalled();
    expect(harnessed.activity.append).not.toHaveBeenCalled();
  });

  it("项目不可写或模块不存在时统一按模块不存在返回 404", async () => {
    const blocked = harness();
    blocked.values.projectWritable = false;
    const notWritable = await deleteModule(blocked).catch(
      (caught: unknown) => caught,
    );
    expect(notWritable).toMatchObject({
      status: 404,
      code: "MODULE_NOT_FOUND",
    });
    expect(blocked.modules.findForDeletion).not.toHaveBeenCalled();

    const absent = harness();
    absent.values.module = null;
    const notFound = await deleteModule(absent).catch(
      (caught: unknown) => caught,
    );
    expect(notFound).toMatchObject({ status: 404, code: "MODULE_NOT_FOUND" });
    expect(absent.modules.hardDelete).not.toHaveBeenCalled();
  });

  it("模块版本不一致返回 409，且不调用物理删除、不写审计与动态", async () => {
    const harnessed = harness();

    const error = await harnessed.workflow
      .deleteModule(7, 3, 9, 5, null, "req-1")
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      status: 409,
      code: "MODULE_VERSION_CONFLICT",
    });
    expect(harnessed.modules.hardDelete).not.toHaveBeenCalled();
    expect(harnessed.audit.append).not.toHaveBeenCalled();
    expect(harnessed.activity.append).not.toHaveBeenCalled();
  });

  it("数据库在取锁后判定版本冲突时同样返回 409 且不写事件", async () => {
    const harnessed = harness();
    harnessed.values.moduleHardDeleteResult = undefined;

    const error = await deleteModule(harnessed).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      status: 409,
      code: "MODULE_VERSION_CONFLICT",
    });
    expect(harnessed.modules.hardDelete).toHaveBeenCalledOnce();
    expect(harnessed.audit.append).not.toHaveBeenCalled();
    expect(harnessed.activity.append).not.toHaveBeenCalled();
  });

  it("模块物理删除返回级联计数，并只追加一条 module.delete 与动态", async () => {
    const harnessed = harness();

    const result = await deleteModule(harnessed);

    expect(result).toEqual({
      id: 9,
      projectId: 3,
      code: "PAY-M-2",
      name: "结算模块",
      kind: "NORMAL",
      deletedTaskCount: 3,
      deletedRecordCount: 4,
      removedLinkCount: 5,
    });
    expect(harnessed.modules.hardDelete).toHaveBeenCalledWith(
      harnessed.tx,
      moduleRow,
      7,
      "模块下线",
    );
    expect(harnessed.audit.append).toHaveBeenCalledOnce();
    expect(harnessed.audit.append).toHaveBeenCalledWith(
      harnessed.tx,
      expect.objectContaining({
        action: "module.delete",
        targetType: "MODULE",
        targetId: "9",
        eventPayload: {
          moduleId: 9,
          code: "PAY-M-2",
          name: "结算模块",
          kind: "NORMAL",
          deletedTaskCount: 3,
          deletedRecordCount: 4,
          removedLinkCount: 5,
          reason: "模块下线",
        },
      }),
    );
    expect(harnessed.activity.updateEntityVisibility).toHaveBeenCalledWith(
      harnessed.tx,
      {
        projectId: 3,
        sourceEntityType: "MODULE",
        sourceEntityId: 9,
        visibilityScope: "MEMBER",
        sourceStatus: "DELETED",
        sourceRowVersion: 5,
      },
    );
    expect(harnessed.activity.append).toHaveBeenCalledOnce();
    expect(harnessed.activity.append).toHaveBeenCalledWith(
      harnessed.tx,
      expect.objectContaining({
        activityType: "MODULE_DELETED",
        sourceEntityType: "MODULE",
        sourceEntityId: 9,
        sourceChainId: "PROJECT:3",
        sourceSequence: 12,
        metadata: {
          moduleId: 9,
          code: "PAY-M-2",
          kind: "NORMAL",
          deletedTaskCount: 3,
          deletedRecordCount: 4,
          removedLinkCount: 5,
        },
      }),
    );
  });

  it("空原因回落默认文案，审计与日志使用同一份原因", async () => {
    const moduleHarnessed = harness();
    await moduleHarnessed.workflow.deleteModule(7, 3, 9, 4, "   ", "req-1");
    expect(moduleHarnessed.modules.hardDelete).toHaveBeenCalledWith(
      moduleHarnessed.tx,
      moduleRow,
      7,
      "模块已被删除",
    );
    expect(
      (
        moduleHarnessed.audit.append.mock.calls[0]?.[1] as {
          eventPayload: { reason: string };
        }
      ).eventPayload.reason,
    ).toBe("模块已被删除");
  });
});
