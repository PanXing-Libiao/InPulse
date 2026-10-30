import React from "react";
import { ConfigProvider } from "antd";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import {
  ApiError,
  type PublishedRecord,
  type ReadableRecord,
  type InpulseApiClient,
} from "@generated/api";
import { RecordLifecycleButton } from "./RecordLifecycleButton";
const item: PublishedRecord = {
  id: 7,
  projectId: 1,
  moduleId: 2,
  taskId: null,
  handlerId: 3,
  authorId: 3,
  status: "PUBLISHED",
  code: "SHOP-CR-1",
  currentVersion: 1,
  rowVersion: 2,
  publishedAt: "2026-09-10T00:00:00.000Z",
  createdAt: "2026-09-10T00:00:00.000Z",
  updatedAt: "2026-09-10T00:00:00.000Z",
  title: "支付修订",
  contextProblem: "问题",
  changeSolution: "原方案",
  resultVerification: "验证",
  remainingIssues: [{ content: "需要跟进" }],
  leftovers: [
    {
      id: 9,
      content: "需要跟进",
      status: "ACTIVE",
      rowVersion: 1,
      linkedTaskId: null,
    },
  ],
};

function mount(api: InpulseApiClient, record: ReadableRecord = item) {
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <QueryClientProvider client={new QueryClient()}>
        <RecordLifecycleButton item={record} api={api} onChanged={() => {}} />
      </QueryClientProvider>
    </ConfigProvider>,
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: record.status === "VOID" ? "恢复记录" : "作废记录",
    }),
  );
}
// antd Button 在 loading 消失前会静默吞掉点击（handleClick 以 innerLoading 提前返回），
// 因此确认前等待 loading 类消失，避免“按钮已 enabled 但点击无效”的竞态。
async function clickConfirm(name: string) {
  await waitFor(() => {
    const confirm = screen.getByRole("button", { name });
    expect(confirm).toBeEnabled();
    expect(confirm).not.toHaveClass("ant-btn-loading");
  });
  fireEvent.click(screen.getByRole("button", { name }));
}
it("requires reason, sends If-Match and preserves input/key on retry", async () => {
  const save = vi
    .fn()
    .mockRejectedValueOnce(Error("network"))
    .mockResolvedValue({ id: 7, projectId: 1, status: "VOID", rowVersion: 3 });
  const api = {
    issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "a".repeat(43) }),
    voidChangeRecord: save,
  } as unknown as InpulseApiClient;
  mount(api);
  expect(screen.getByRole("button", { name: "确认作废记录" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("作废原因"), {
    target: { value: "  误发布  " },
  });
  await clickConfirm("确认作废记录");
  await screen.findByText("暂时无法操作，原因已保留，可重试。");
  expect(screen.getByLabelText("作废原因")).toHaveValue("  误发布  ");
  await clickConfirm("确认作废记录");
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[0]).toEqual(save.mock.calls[1]);
  expect(save.mock.calls[0]).toMatchObject([
    1,
    7,
    { reason: "误发布" },
    { headers: { "If-Match": '"2"' } },
  ]);
});
it("409 requires loading current state and explicit confirmation before restoring", async () => {
  const voided = {
    ...item,
    status: "VOID" as const,
    rowVersion: 3,
    voidedAt: item.updatedAt,
    voidReason: "已有原因",
  };
  const save = vi.fn().mockRejectedValue(
    new ApiError(409, {
      code: "RECORD_STATE_CONFLICT",
      message: "冲突",
      details: {},
      requestId: "r",
    }),
  );
  const restore = vi.fn().mockResolvedValue({
    id: 7,
    projectId: 1,
    status: "PUBLISHED",
    rowVersion: 4,
  });
  const api = {
    issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "a".repeat(43) }),
    voidChangeRecord: save,
    restoreChangeRecord: restore,
    getChangeRecord: vi.fn().mockResolvedValue(voided),
  } as unknown as InpulseApiClient;
  mount(api);
  fireEvent.change(screen.getByLabelText("作废原因"), {
    target: { value: "需要处理" },
  });
  await clickConfirm("确认作废记录");
  await screen.findByText(
    "记录或父级状态已变化。请加载最新状态，核对后重新确认。",
  );
  expect(screen.getByRole("button", { name: "确认作废记录" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "加载最新状态" }));
  await screen.findByLabelText("恢复原因");
  expect(restore).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "确认恢复记录" })).toBeEnabled(),
  );
  await clickConfirm("确认恢复记录");
  await waitFor(() => expect(restore).toHaveBeenCalledOnce());
  expect(restore.mock.calls[0]).toMatchObject([
    1,
    7,
    { reason: "需要处理" },
    { headers: { "If-Match": '"3"' } },
  ]);
});
it("keeps the reason and reports the missing administrator rights on 403", async () => {
  const api = {
    issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "a".repeat(43) }),
    voidChangeRecord: vi.fn().mockRejectedValue(
      new ApiError(403, {
        code: "ADMIN_REQUIRED",
        message: "验证",
        details: {},
        requestId: "r",
      }),
    ),
  } as unknown as InpulseApiClient;
  mount(api);
  fireEvent.change(screen.getByLabelText("作废原因"), {
    target: { value: "保留此原因" },
  });
  await clickConfirm("确认作废记录");
  await screen.findByText("只有系统管理员可以作废或恢复记录。");
  expect(screen.getByLabelText("作废原因")).toHaveValue("保留此原因");
});

it("retains refresh gate after failed reload and close/reopen until explicit latest-version confirmation", async () => {
  const save = vi
    .fn()
    .mockRejectedValueOnce(
      new ApiError(409, {
        code: "RECORD_STATE_CONFLICT",
        message: "冲突",
        details: {},
        requestId: "r",
      }),
    )
    .mockResolvedValue({ id: 7, projectId: 1, status: "VOID", rowVersion: 4 });
  const reload = vi
    .fn()
    .mockRejectedValueOnce(
      new ApiError(500, {
        code: "INTERNAL_ERROR",
        message: "失败",
        details: {},
        requestId: "r",
      }),
    )
    .mockRejectedValueOnce(Error("network"))
    .mockResolvedValue({ ...item, rowVersion: 3 });
  const api = {
    issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "a".repeat(43) }),
    voidChangeRecord: save,
    getChangeRecord: reload,
  } as unknown as InpulseApiClient;
  mount(api);
  fireEvent.change(screen.getByLabelText("作废原因"), {
    target: { value: "需要保留的原因" },
  });
  await clickConfirm("确认作废记录");
  await screen.findByText(
    "记录或父级状态已变化。请加载最新状态，核对后重新确认。",
  );
  fireEvent.click(screen.getByRole("button", { name: "加载最新状态" }));
  await screen.findByText("暂时无法操作，原因已保留，可重试。");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "确认作废记录" })).toBeDisabled(),
  );
  expect(screen.getByRole("button", { name: "加载最新状态" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: /取\s*消/ }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole("button", { name: "作废记录" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "确认作废记录" })).toBeDisabled(),
  );
  expect(screen.getByLabelText("作废原因")).toHaveValue("需要保留的原因");
  fireEvent.click(screen.getByRole("button", { name: "加载最新状态" }));
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "加载最新状态" })).toBeEnabled(),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "确认作废记录" })).toBeDisabled(),
  );
  expect(save).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "加载最新状态" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "确认作废记录" })).toBeEnabled(),
  );
  expect(save).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText("作废原因")).toHaveValue("需要保留的原因");
  await clickConfirm("确认作废记录");
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1]).toMatchObject([
    1,
    7,
    { reason: "需要保留的原因" },
    { headers: { "If-Match": '"3"' } },
  ]);
  expect(save.mock.calls[1]![3].headers["Idempotency-Key"]).not.toBe(
    save.mock.calls[0]![3].headers["Idempotency-Key"],
  );
});

it("keeps the confirm accessible name stable while a reload is pending", async () => {
  const save = vi.fn().mockRejectedValue(
    new ApiError(409, {
      code: "RECORD_STATE_CONFLICT",
      message: "冲突",
      details: {},
      requestId: "r",
    }),
  );
  let releaseReload: (record: ReadableRecord) => void = () => {};
  const reload = vi.fn(
    () =>
      new Promise<ReadableRecord>((resolve) => {
        releaseReload = resolve;
      }),
  );
  const api = {
    issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "a".repeat(43) }),
    voidChangeRecord: save,
    getChangeRecord: reload,
  } as unknown as InpulseApiClient;
  mount(api);
  fireEvent.change(screen.getByLabelText("作废原因"), {
    target: { value: "需要处理" },
  });
  await clickConfirm("确认作废记录");
  await screen.findByText(
    "记录或父级状态已变化。请加载最新状态，核对后重新确认。",
  );
  fireEvent.click(screen.getByRole("button", { name: "加载最新状态" }));
  expect(reload).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "确认作废记录" })).toBeDisabled();
  await act(async () => {
    releaseReload({ ...item, rowVersion: 3 });
  });
  expect(screen.getByRole("button", { name: "确认作废记录" })).toBeEnabled();
});
