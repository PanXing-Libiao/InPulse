import React from "react";
import { it, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ApiError,
  type InpulseApiClient,
  type ChangeRecordVersion,
} from "@generated/api";
import {
  PublishedRecordDetail,
  compareRecordVersions,
} from "./PublishedRecordDetail";
import type { TaskLocation } from "@features/tasks/task-links";
vi.mock("@features/auth/auth-context", () => ({
  useAuth: () => ({ user: { id: 3, isAdmin: false } }),
}));
const first: ChangeRecordVersion = {
  recordId: 7,
  projectId: 1,
  versionNo: 1,
  createdBy: 3,
  createdAt: "2026-09-10T00:00:00.000Z",
  title: "支付修订",
  contextProblem: "重复请求",
  changeSolution: "增加幂等",
  resultVerification: "初次验证",
  remainingIssues: [],
  leftovers: [],
};
const second: ChangeRecordVersion = {
  ...first,
  versionNo: 2,
  resultVerification: "追加并发验证",
};
const item = {
  ...second,
  id: 7,
  moduleId: 2,
  taskId: null,
  handlerId: 3,
  authorId: 3,
  status: "PUBLISHED",
  code: "SHOP-CR-1",
  currentVersion: 2,
  publishedAt: first.createdAt,
  createdAt: first.createdAt,
  updatedAt: first.createdAt,
  rowVersion: 3,
  leftovers: [],
};
function mountDetail(
  api: InpulseApiClient,
  {
    standalone = true,
    onOpenTask,
  }: {
    standalone?: boolean;
    onOpenTask?: (location: TaskLocation) => void;
  } = {},
) {
  return render(
    <MemoryRouter initialEntries={["/records?projectId=1&publishedId=7"]}>
      <QueryClientProvider client={new QueryClient()}>
        <PublishedRecordDetail
          projectId={1}
          recordId={7}
          client={api}
          writable
          standalone={standalone}
          onOpenTask={onOpenTask}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
/**
 * 记录接口只回传 ID；没有列表语境时详情会补查项目、模块与用户目录。
 * 这里给出最小可解析响应，让断言专注记录正文本身。
 */
function withNameSources(api: Record<string, unknown>) {
  return {
    getProject: vi.fn().mockResolvedValue({
      project: { id: 1, name: "支付项目" },
      currentUserRole: "LEADER",
    }),
    listModules: vi
      .fn()
      .mockResolvedValue({ items: [{ id: 2, name: "支付模块" }] }),
    getUserDirectory: vi
      .fn()
      .mockResolvedValue({ items: [{ id: 3, name: "邵晨宇" }] }),
    ...api,
  } as unknown as InpulseApiClient;
}
it("compares exact immutable version content and identifies unchanged fields", () => {
  const diff = compareRecordVersions(first, second);
  expect(diff.filter((x) => x.changed)).toEqual([
    {
      field: "resultVerification",
      label: "改动效果",
      before: "初次验证",
      after: "追加并发验证",
      changed: true,
    },
  ]);
});
it("loads real version data and permits selecting historical snapshots", async () => {
  const api = withNameSources({
    getChangeRecord: vi.fn().mockResolvedValue(item),
    listChangeRecordVersions: vi
      .fn()
      .mockResolvedValue({ items: [second, first] }),
  });
  mountDetail(api);
  const diff = within(await screen.findByRole("generic", { name: "版本差异" }));
  expect(diff.getByText("初次验证")).toBeVisible();
  expect(diff.getByText("追加并发验证")).toBeVisible();
  // 无变化字段不再渲染：标题等四项不应出现在差异区。
  expect(diff.queryByText("迭代标题")).toBeNull();
  const region = screen.getByRole("region", { name: "正式记录详情" });
  // 2026-09-18 起详情页头只保留标题（页面标题上方的小字已移除），按合并后实现断言标题。
  const compareField = within(region).getByLabelText("对照版本");
  const compareTrigger = compareField.closest(".ant-select");
  if (!compareTrigger) {
    throw new Error("compare select not found");
  }
  fireEvent.mouseDown(compareTrigger);
  // 「较早版本」与「对照版本」选项文案相同：按 aria-owns 定位本次打开的弹层，避免选错。
  const listId = compareField.getAttribute("aria-owns") ?? "";
  const list = document.getElementById(listId) ?? document.body;
  fireEvent.click(within(list).getByTitle(/^v1 · /));
  expect(diff.getByText("这两个版本的内容完全一致。")).toBeVisible();
  expect(api.listChangeRecordVersions).toHaveBeenCalledWith(
    1,
    7,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});
it("renders the source task link and the four content sections", async () => {
  const api = withNameSources({
    getChangeRecord: vi.fn().mockResolvedValue({ ...item, taskId: 8 }),
    listChangeRecordVersions: vi.fn().mockResolvedValue({ items: [second] }),
  });
  mountDetail(api);
  const region = await screen.findByRole("region", { name: "正式记录详情" });
  const source = await within(region).findByRole("link", {
    name: "查看来源任务",
  });
  expect(source).toHaveAttribute(
    "href",
    "/projects/1/modules/2/tasks?taskId=8",
  );
  expect(within(region).getByText("改动原因")).toBeVisible();
  expect(within(region).getByText("具体改动")).toBeVisible();
  expect(within(region).getByText("改动效果")).toBeVisible();
  expect(within(region).getByText("遗留问题")).toBeVisible();
});
it("renders leftovers of a void record as 已作废 and keeps the follow-up task link", async () => {
  const api = withNameSources({
    getChangeRecord: vi.fn().mockResolvedValue({
      ...item,
      status: "VOID",
      voidedAt: first.createdAt,
      voidReason: "记录作废",
      leftovers: [
        {
          id: 31,
          content: "随记录作废的遗留问题",
          status: "VOIDED",
          rowVersion: 1,
          linkedTaskId: 8,
        },
      ],
    }),
    listChangeRecordVersions: vi
      .fn()
      .mockResolvedValue({ items: [second, first] }),
  });
  mountDetail(api);
  const region = await screen.findByRole("region", { name: "遗留问题列表" });
  expect(await within(region).findByText("已作废")).toBeVisible();
  expect(within(region).getByText("随记录作废的遗留问题")).toBeVisible();
  expect(
    within(region).getByRole("link", { name: "查看跟进任务" }),
  ).toHaveAttribute("href", "/projects/1/modules/2/tasks?taskId=8");
});
it("opens the source task in place when the host passes onOpenTask", async () => {
  const api = withNameSources({
    getChangeRecord: vi.fn().mockResolvedValue({ ...item, taskId: 8 }),
    listChangeRecordVersions: vi.fn().mockResolvedValue({ items: [second] }),
  });
  const onOpenTask = vi.fn();
  mountDetail(api, { onOpenTask });
  const region = await screen.findByRole("region", { name: "正式记录详情" });
  // 2026-10-10 用户指示：宿主能就地打开任务弹窗时，「查看来源任务」不再渲染成
  // 深链 <a href>，而是走回调的按钮（地址栏不变、关掉任务弹窗回到本条记录弹窗）。
  expect(
    within(region).queryByRole("link", { name: "查看来源任务" }),
  ).toBeNull();
  fireEvent.click(
    await within(region).findByRole("button", { name: "查看来源任务" }),
  );
  expect(onOpenTask).toHaveBeenCalledWith({
    projectId: 1,
    moduleId: 2,
    taskId: 8,
  });
});
it("explains a missing or unauthorized record without leaking existence", async () => {
  const api = withNameSources({
    getChangeRecord: vi.fn().mockRejectedValue(
      new ApiError(404, {
        code: "NOT_FOUND",
        message: "不存在",
        requestId: "test",
        details: {},
      }),
    ),
    listChangeRecordVersions: vi.fn().mockResolvedValue({ items: [] }),
  });
  mountDetail(api);
  expect(await screen.findByText("记录不存在或当前无法访问。")).toBeVisible();
});
it("resolves the ownership and author names when there is no list context", async () => {
  const api = withNameSources({
    getChangeRecord: vi.fn().mockResolvedValue(item),
    listChangeRecordVersions: vi.fn().mockResolvedValue({ items: [second] }),
  });
  mountDetail(api);
  const region = await screen.findByRole("region", { name: "正式记录详情" });
  expect(await within(region).findByText("支付项目 / 支付模块")).toBeVisible();
  expect(within(region).getByText(/邵晨宇 · 创建/)).toBeVisible();
  expect(within(region).queryByText(/用户 #3/)).toBeNull();
});
it("leaves the record identity to the card summary when not standalone", async () => {
  const api = withNameSources({
    getChangeRecord: vi.fn().mockResolvedValue(item),
    listChangeRecordVersions: vi
      .fn()
      .mockResolvedValue({ items: [second, first] }),
  });
  mountDetail(api, { standalone: false });
  const region = await screen.findByRole("region", { name: "正式记录详情" });
  expect(await within(region).findByText("归属")).toBeVisible();
  expect(within(region).queryByText("支付修订")).toBeNull();
});
it("hides the version comparison until a record has more than one version", async () => {
  const api = withNameSources({
    getChangeRecord: vi.fn().mockResolvedValue(item),
    listChangeRecordVersions: vi.fn().mockResolvedValue({ items: [second] }),
  });
  mountDetail(api);
  const region = await screen.findByRole("region", { name: "正式记录详情" });
  expect(await within(region).findByText("归属")).toBeVisible();
  expect(within(region).queryByLabelText("较早版本")).toBeNull();
});
