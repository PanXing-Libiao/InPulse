import React from "react";
import { ConfigProvider } from "antd";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import {
  ApiError,
  type InpulseApiClient,
  type ModuleTaskItem,
} from "@generated/api";
import { CompleteWithRecord } from "./CompleteWithRecord";
const task: ModuleTaskItem = {
  id: 1,
  projectId: 2,
  moduleId: 3,
  code: "SHOP-T-1",
  title: "任务标题",
  description: "",
  assigneeId: 5,
  assigneeIds: [5],
  creatorId: 5,
  priority: "NORMAL",
  workStatus: "TODO",
  lifecycleStatus: "ACTIVE",
  dueAt: null,
  rowVersion: 1,
  createdAt: "2026-09-10T00:00:00.000Z",
  updatedAt: "2026-09-10T00:00:00.000Z",
};
const draft = {
  id: 7,
  projectId: 2,
  moduleId: 3,
  taskId: null,
  title: "已存草稿",
  rowVersion: 2,
  contextProblem: "问题",
  changeSolution: "方案",
  resultVerification: "验证",
  remainingIssues: [],
};
function selectTrigger(label: string): HTMLElement {
  const trigger = screen.getByLabelText(label).closest(".ant-select");
  if (!trigger) {
    throw new Error("select trigger not found for " + label);
  }
  return trigger as HTMLElement;
}

/** CalmSelect 交互：打开下拉并点选目标项（弹层项带 title 属性）。 */
function pickSelectOption(label: string, optionTitle: RegExp | string) {
  fireEvent.mouseDown(selectTrigger(label));
  fireEvent.click(screen.getByTitle(optionTitle));
}

function mount(extra: object) {
  const api = {
    issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "a".repeat(43) }),
    // 任务链接清单：默认没有链接，用例按需覆盖（渲染前就会发这次请求）。
    listExternalLinks: vi.fn().mockResolvedValue({
      projectId: 2,
      targetType: "TASK",
      targetId: 1,
      rowVersion: 1,
      writable: true,
      items: [],
    }),
    ...extra,
  } as unknown as InpulseApiClient;
  const done = vi.fn();
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <QueryClientProvider client={new QueryClient()}>
        <CompleteWithRecord item={task} api={api} writable onSuccess={done} />
      </QueryClientProvider>
    </ConfigProvider>,
  );
  return done;
}
/** 任务上的 GitHub 链接夹具；`kind` 决定徽章文案（Commit / Issue / PR …）。 */
function taskLink(id: number, normalizedUrl: string, kind: string) {
  return {
    id,
    projectId: 2,
    normalizedUrl,
    kind,
    label: normalizedUrl,
    repository: "owner/repo",
    externalNumber: null,
    externalSha: null,
    releaseTag: null,
    isRootRepository: false,
  };
}
/** 填满正文三段，让「发布并完成任务」可用。 */
function fillBody() {
  for (const label of ["改动原因", "具体改动", "改动效果"])
    fireEvent.change(screen.getByLabelText(label), {
      target: { value: "真实内容" },
    });
}
it("requires core content and reuses the exact request key after uncertain failure", async () => {
  const completeTask = vi
    .fn()
    .mockRejectedValueOnce(Error("network"))
    .mockResolvedValue({
      task: { ...task, workStatus: "DONE" },
      record: { id: 7, projectId: 2 },
    });
  const done = mount({ completeTask });
  expect(screen.getByRole("button", { name: "发布并完成任务" })).toBeDisabled();
  for (const label of ["改动原因", "具体改动", "改动效果"])
    fireEvent.change(screen.getByLabelText(label), {
      target: { value: "真实内容" },
    });
  fireEvent.click(screen.getByRole("button", { name: "发布并完成任务" }));
  await screen.findByText("服务暂时不可用，输入和选择已保留，可重试。");
  expect(screen.getByLabelText("具体改动")).toHaveValue("真实内容");
  fireEvent.click(screen.getByRole("button", { name: "发布并完成任务" }));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(completeTask.mock.calls[0]).toEqual(completeTask.mock.calls[1]);
  expect(completeTask.mock.calls[0]![1]).toEqual({
    mode: "WITH_RECORD",
    expectedRowVersion: 1,
    record: {
      title: "任务标题",
      contextProblem: "真实内容",
      changeSolution: "真实内容",
      resultVerification: "真实内容",
      remainingIssues: [],
    },
  });
});
it("requires explicit draft selection and explicit confirmation of its changed content before retrying a conflict", async () => {
  const completeTask = vi
    .fn()
    .mockRejectedValueOnce(
      new ApiError(409, {
        code: "RECORD_VERSION_CONFLICT",
        message: "草稿版本变化",
        details: {},
        requestId: "r",
      }),
    )
    .mockResolvedValue({ task, record: { id: 7, projectId: 2 } });
  mount({
    completeTask,
    listRecordDrafts: vi.fn().mockResolvedValue({
      items: [draft, { ...draft, id: 8, taskId: 999, title: "不匹配草稿" }],
      nextCursor: null,
      hasMore: false,
    }),
    getRecordDraft: vi
      .fn()
      .mockResolvedValue({ ...draft, title: "新版标题", rowVersion: 3 }),
    getModuleTask: vi.fn().mockResolvedValue({ ...task, rowVersion: 2 }),
  });
  pickSelectOption("记录来源", "选择已有草稿");
  await screen.findByLabelText("待发布草稿");
  expect(selectTrigger("待发布草稿")).toHaveTextContent("请选择一条草稿");
  fireEvent.mouseDown(selectTrigger("待发布草稿"));
  expect(screen.queryByTitle(/不匹配草稿/)).toBeNull();
  pickSelectOption("待发布草稿", /草稿 #7 · 版本 2/);
  fireEvent.click(screen.getByRole("button", { name: "发布并完成任务" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "加载最新任务和草稿" }),
  );
  await screen.findByText("最新草稿：新版标题（版本 3）");
  expect(screen.getByRole("button", { name: "发布并完成任务" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "确认使用最新草稿" }));
  fireEvent.click(screen.getByRole("button", { name: "发布并完成任务" }));
  await waitFor(() => expect(completeTask).toHaveBeenCalledTimes(2));
  expect(completeTask.mock.calls[1]![1]).toEqual({
    mode: "WITH_RECORD",
    expectedRowVersion: 2,
    recordDraftId: 7,
    recordExpectedRowVersion: 3,
  });
  expect(completeTask.mock.calls[1]![2].headers["Idempotency-Key"]).not.toBe(
    completeTask.mock.calls[0]![2].headers["Idempotency-Key"],
  );
});
it("把勾选的任务链接沿用到新发布的迭代记录上，取消勾选的不带走", async () => {
  const commitUrl = "https://github.com/owner/repo/commit/abc1234def5678";
  const issueUrl = "https://github.com/owner/repo/issues/12";
  const record = { id: 71, projectId: 2, code: "SHOP-CR-71", rowVersion: 4 };
  const completeTask = vi
    .fn()
    .mockResolvedValue({ task: { ...task, workStatus: "DONE" }, record });
  const addExternalLink = vi.fn().mockResolvedValue({ rowVersion: 5 });
  const done = mount({
    completeTask,
    addExternalLink,
    // 记录侧读回的 rowVersion 与发布响应不同，用来证明关联用的是刚读到的版本。
    listExternalLinks: vi.fn(async (targetType: string) =>
      targetType === "TASK"
        ? {
            projectId: 2,
            targetType: "TASK",
            targetId: 1,
            rowVersion: 1,
            writable: true,
            items: [
              taskLink(11, commitUrl, "COMMIT"),
              taskLink(12, issueUrl, "ISSUE"),
            ],
          }
        : {
            projectId: 2,
            targetType: "CHANGE_RECORD",
            targetId: 71,
            rowVersion: 4,
            writable: true,
            items: [],
          },
    ),
  });
  fillBody();
  // 任务上已有的链接收在下拉框里：先展开，再定位可勾选行。
  fireEvent.click(
    await screen.findByRole("button", { name: /已选 2 \/ 2 条任务链接/ }),
  );
  const boxes = screen.getAllByRole("checkbox");
  expect(boxes).toHaveLength(2);
  fireEvent.click(boxes[1]!);
  // 取消勾选后触发器同步计数。
  expect(
    screen.getByRole("button", { name: /已选 1 \/ 2 条任务链接/ }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "发布并完成任务" }));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(addExternalLink).toHaveBeenCalledOnce();
  expect(addExternalLink.mock.calls[0]![0]).toBe("CHANGE_RECORD");
  expect(addExternalLink.mock.calls[0]![1]).toBe(71);
  expect(addExternalLink.mock.calls[0]![2]).toEqual({ url: commitUrl });
  const headers = addExternalLink.mock.calls[0]![3].headers;
  expect(headers["x-csrf-token"]).toBe("a".repeat(43));
  expect(headers["If-Match"]).toBe('"4"');
  expect(headers["Idempotency-Key"]).toBeTruthy();
  expect(done.mock.calls[0]![0].rowVersion).toBe(5);
});
it("自己添加的链接发布后除记录外还关联到来源任务", async () => {
  const ownUrl = "https://github.com/owner/repo/pull/22312";
  const record = { id: 71, projectId: 2, code: "SHOP-CR-71", rowVersion: 4 };
  const completeTask = vi
    .fn()
    .mockResolvedValue({ task: { ...task, workStatus: "DONE" }, record });
  const addExternalLink = vi
    .fn()
    .mockImplementation(async (targetType: string) => ({
      rowVersion: targetType === "TASK" ? 2 : 5,
    }));
  const done = mount({
    completeTask,
    addExternalLink,
    // 两个目标各自读回自己的链接版本，关联用的 If-Match 不能串。
    listExternalLinks: vi.fn(async (targetType: string) => ({
      projectId: 2,
      targetType,
      targetId: targetType === "TASK" ? 1 : 71,
      rowVersion: targetType === "TASK" ? 1 : 4,
      writable: true,
      items: [],
    })),
  });
  fillBody();
  const input = await screen.findByLabelText("GitHub 链接地址");
  fireEvent.change(input, { target: { value: ownUrl } });
  fireEvent.click(screen.getByRole("button", { name: "添加链接" }));
  await screen.findByRole("button", { name: "移除 " + ownUrl });
  fireEvent.click(screen.getByRole("button", { name: "发布并完成任务" }));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(addExternalLink).toHaveBeenCalledTimes(2);
  expect(addExternalLink.mock.calls[0]![0]).toBe("CHANGE_RECORD");
  expect(addExternalLink.mock.calls[0]![1]).toBe(71);
  expect(addExternalLink.mock.calls[0]![3].headers["If-Match"]).toBe('"4"');
  expect(addExternalLink.mock.calls[1]![0]).toBe("TASK");
  expect(addExternalLink.mock.calls[1]![1]).toBe(1);
  expect(addExternalLink.mock.calls[1]![2]).toEqual({ url: ownUrl });
  expect(addExternalLink.mock.calls[1]![3].headers["If-Match"]).toBe('"1"');
});
it("自己添加的链接要过 GitHub 校验，非法与重复输入被拦下", async () => {
  const issueUrl = "https://github.com/owner/repo/issues/12";
  mount({
    listExternalLinks: vi.fn().mockResolvedValue({
      projectId: 2,
      targetType: "TASK",
      targetId: 1,
      rowVersion: 1,
      writable: true,
      items: [taskLink(12, issueUrl, "ISSUE")],
    }),
  });
  const input = await screen.findByLabelText("GitHub 链接地址");
  fireEvent.change(input, { target: { value: "https://example.com/x" } });
  fireEvent.click(screen.getByRole("button", { name: "添加链接" }));
  await screen.findByText("只接受 github.com 的 HTTPS 链接，请检查输入。");
  fireEvent.change(input, { target: { value: issueUrl } });
  fireEvent.click(screen.getByRole("button", { name: "添加链接" }));
  await screen.findByText("这条链接已经在要关联的列表里。");
  // 裸 commit SHA 同样合法，落成待关联条目并清空输入框。
  const sha = "abc1234def5678abc1234def5678abc1234def56";
  fireEvent.change(input, { target: { value: sha } });
  fireEvent.click(screen.getByRole("button", { name: "添加链接" }));
  const remove = await screen.findByRole("button", { name: "移除 " + sha });
  expect(input).toHaveValue("");
  fireEvent.click(remove);
  expect(screen.queryByRole("button", { name: "移除 " + sha })).toBeNull();
});
it("记录已发布但链接关联失败时给出重试入口且不能重复提交", async () => {
  const commitUrl = "https://github.com/owner/repo/commit/abc1234def5678";
  const record = { id: 71, projectId: 2, code: "SHOP-CR-71", rowVersion: 4 };
  const completeTask = vi
    .fn()
    .mockResolvedValue({ task: { ...task, workStatus: "DONE" }, record });
  const addExternalLink = vi
    .fn()
    .mockRejectedValueOnce(
      new ApiError(500, {
        code: "INTERNAL_ERROR",
        message: "服务器错误",
        details: {},
        requestId: "r",
      }),
    )
    .mockResolvedValue({ rowVersion: 5 });
  const done = mount({
    completeTask,
    addExternalLink,
    listExternalLinks: vi.fn(async (targetType: string) => ({
      projectId: 2,
      targetType,
      targetId: 71,
      rowVersion: 4,
      writable: true,
      items: targetType === "TASK" ? [taskLink(11, commitUrl, "COMMIT")] : [],
    })),
  });
  fillBody();
  fireEvent.click(
    await screen.findByRole("button", { name: /已选 1 \/ 1 条任务链接/ }),
  );
  await screen.findByText(commitUrl);
  fireEvent.click(screen.getByRole("button", { name: "发布并完成任务" }));
  await screen.findByText(/已发布，下列链接尚未关联/);
  expect(done).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "发布并完成任务" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "重试关联" }));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(addExternalLink).toHaveBeenCalledTimes(2);
  expect(addExternalLink.mock.calls[1]![2]).toEqual({ url: commitUrl });
});
