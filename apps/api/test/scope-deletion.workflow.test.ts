import { describe, expect, it, vi } from "vitest";
import type { TransactionContext } from "../src/database/transaction-context.js";
import { ModuleDeletionError } from "../src/modules/modules/module-deletion.command-port.js";
import { ScopeDeletionWorkflow } from "../src/workflows/scope-deletion.workflow.js";

/**
 * ADR-096：模块/功能删除 Workflow 只负责门禁、调用数据库窄口函数、追加一条
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
  deletedFeatureCount: 2,
  deletedTaskCount: 3,
  deletedRecordCount: 4,
  removedLinkCount: 5,
};

const featureRow = {
  id: 11,
  projectId: 3,
  moduleId: 9,
  code: "PAY-F-4",
  name: "对账功能",
  rowVersion: 2,
};

const deletedFeature = {
  ...featureRow,
  deletedAt: "2026-10-23T00:00:00.000Z",
  deletedTaskCount: 3,
  deletedRecordCount: 4,
  removedLinkCount: 2,
};

function harness() {
  const tx = {} as TransactionContext;
  const order: string[] = [];
  const values = {
    projectWritable: true,
    module: moduleRow as typeof moduleRow | null,
    moduleKind: "NORMAL" as "NORMAL" | "UNCLASSIFIED",
    feature: featureRow as typeof featureRow | null,
    moduleHardDeleteResult: deletedModule as typeof deletedModule | undefined,
    featureHardDeleteResult: deletedFeature as
      typeof deletedFeature | undefined,
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
    features: {
      authorize: vi.fn(async (..._args: unknown[]) =>
        step("authorize-feature", undefined),
      ),
      findForDeletion: vi.fn(async (..._args: unknown[]) =>
        step("find-feature", values.feature),
      ),
      hardDelete: vi.fn(async (..._args: unknown[]) =>
        step("hard-delete-feature", values.featureHardDeleteResult),
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
    deps.features as never,
    deps.audit as never,
    deps.activity as never,
  );
  return { ...deps, workflow };
}

const deleteModule = (harnessed: ReturnType<typeof harness>) =>
  harnessed.workflow.deleteModule(7, 3, 9, 4, "模块下线", "req-1");

const deleteFeature = (harnessed: ReturnType<typeof harness>) =>
  harnessed.workflow.deleteFeature(7, 3, 9, 11, 2, "功能下线", "req-2");

describe("ADR-096 物理删除模块与功能的跨域编排", () => {
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
      deletedFeatureCount: 2,
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
    expect(harnessed.features.hardDelete).not.toHaveBeenCalled();
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
          deletedFeatureCount: 2,
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
          deletedFeatureCount: 2,
          deletedTaskCount: 3,
          deletedRecordCount: 4,
          removedLinkCount: 5,
        },
      }),
    );
  });

  it("功能物理删除只操作本功能，所属模块保留", async () => {
    const harnessed = harness();

    const result = await deleteFeature(harnessed);

    expect(result).toEqual({
      id: 11,
      projectId: 3,
      moduleId: 9,
      code: "PAY-F-4",
      name: "对账功能",
      deletedTaskCount: 3,
      deletedRecordCount: 4,
      removedLinkCount: 2,
    });
    expect(harnessed.features.hardDelete).toHaveBeenCalledWith(
      harnessed.tx,
      featureRow,
      7,
      "功能下线",
    );
    expect(harnessed.modules.hardDelete).not.toHaveBeenCalled();
    expect(harnessed.audit.append).toHaveBeenCalledOnce();
    expect(harnessed.audit.append).toHaveBeenCalledWith(
      harnessed.tx,
      expect.objectContaining({
        action: "feature.delete",
        targetType: "FEATURE",
        targetId: "11",
        eventPayload: {
          featureId: 11,
          moduleId: 9,
          code: "PAY-F-4",
          name: "对账功能",
          deletedTaskCount: 3,
          deletedRecordCount: 4,
          removedLinkCount: 2,
          reason: "功能下线",
        },
      }),
    );
    expect(harnessed.activity.append).toHaveBeenCalledWith(
      harnessed.tx,
      expect.objectContaining({
        activityType: "FEATURE_DELETED",
        sourceEntityType: "FEATURE",
        sourceEntityId: 11,
        sourceRowVersion: 3,
        metadata: {
          featureId: 11,
          moduleId: 9,
          code: "PAY-F-4",
          deletedTaskCount: 3,
          deletedRecordCount: 4,
          removedLinkCount: 2,
        },
      }),
    );
  });

  it("功能不存在或版本冲突时不调用物理删除", async () => {
    const absent = harness();
    absent.values.feature = null;
    expect(
      await deleteFeature(absent).catch((caught: unknown) => caught),
    ).toMatchObject({ status: 404, code: "FEATURE_NOT_FOUND" });
    expect(absent.features.hardDelete).not.toHaveBeenCalled();

    const stale = harness();
    const error = await stale.workflow
      .deleteFeature(7, 3, 9, 11, 3, null, "req-2")
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      status: 409,
      code: "FEATURE_VERSION_CONFLICT",
    });
    expect(stale.features.hardDelete).not.toHaveBeenCalled();
    expect(stale.audit.append).not.toHaveBeenCalled();
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

    const featureHarnessed = harness();
    await featureHarnessed.workflow.deleteFeature(
      7,
      3,
      9,
      11,
      2,
      null,
      "req-2",
    );
    expect(featureHarnessed.features.hardDelete).toHaveBeenCalledWith(
      featureHarnessed.tx,
      featureRow,
      7,
      "功能已被删除",
    );
    expect(
      (
        featureHarnessed.audit.append.mock.calls[0]?.[1] as {
          eventPayload: { reason: string };
        }
      ).eventPayload.reason,
    ).toBe("功能已被删除");
  });
});
