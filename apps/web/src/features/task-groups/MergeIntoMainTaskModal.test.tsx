import React from "react";
import { ConfigProvider } from "antd";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type InpulseApiClient,
  type SearchItem,
} from "@generated/api";
import { MergeIntoMainTaskModal } from "./MergeIntoMainTaskModal";

const task = { id: 101, code: "PR-T-1", title: "退款主任务", projectId: 2 };

const candidate: SearchItem = {
  projectId: 2,
  entityType: "TASK",
  entityId: 102,
  moduleId: null,
  recordId: null,
  title: "重复回调任务 A",
  summary: "任务",
};
const selfCandidate: SearchItem = {
  ...candidate,
  entityId: 101,
  title: "退款主任务",
};
const otherProjectCandidate: SearchItem = {
  ...candidate,
  projectId: 3,
  entityId: 103,
  title: "其他项目任务",
};
const moduleCandidate: SearchItem = {
  projectId: 2,
  entityType: "MODULE",
  entityId: 104,
  moduleId: null,
  recordId: null,
  title: "退款模块",
  summary: "模块",
};

const searchLabel = /^主任务$/;

/** 打开「主任务」下拉：CalmSelect 的触发器是输入框的 `.ant-select` 祖先（jsdom 下无
 *  真实指针，按仓库已有做法用 mouseDown 展开弹层）。
 */
function openMainTaskDropdown(): void {
  const trigger = screen.getByLabelText(searchLabel).closest(".ant-select");
  if (trigger === null) {
    throw new Error("主任务下拉未找到");
  }
  fireEvent.mouseDown(trigger);
}

/** 触发器当前展示的选中项文本（`.calm-select-trigger-label` 只出现在触发器上）。 */
function selectedMainTaskText(): string | null {
  return (
    document.querySelector(".calm-select-trigger-label")?.textContent ?? null
  );
}

function createApi() {
  const getSearch = vi.fn().mockResolvedValue({
    items: [candidate, selfCandidate, otherProjectCandidate, moduleCandidate],
    nextCursor: null,
    hasMore: false,
  });
  const mergeTaskGroup = vi.fn().mockResolvedValue({
    id: 7,
    projectId: 2,
    code: "TG-7",
    name: "退款聚合组",
    status: "ACTIVE",
    createdAt: "2026-09-10T12:00:00.000Z",
    closedAt: null,
    rowVersion: 1,
  });
  const issueCsrfToken = vi
    .fn()
    .mockResolvedValue({ csrfToken: "a".repeat(43) });
  return {
    api: {
      getSearch,
      mergeTaskGroup,
      issueCsrfToken,
    } as unknown as InpulseApiClient,
    getSearch,
    mergeTaskGroup,
    issueCsrfToken,
  };
}

function mount(options: { api?: InpulseApiClient } = {}) {
  const onMerged = vi.fn();
  const onClose = vi.fn();
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MergeIntoMainTaskModal
          open
          task={task}
          api={options.api ?? createApi().api}
          onClose={onClose}
          onMerged={onMerged}
        />
      </QueryClientProvider>
    </ConfigProvider>,
  );
  return { onMerged, onClose };
}

describe("F-23 merge into main task", () => {
  it("waits for a non-empty query and the debounce before searching", async () => {
    const { api, getSearch } = createApi();
    mount({ api });
    const input = screen.getByLabelText(searchLabel);
    fireEvent.change(input, { target: { value: "   " } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
    expect(getSearch).not.toHaveBeenCalled();
    // 下限为 1（单字可搜，F-26）：键入单字、等过防抖就该发起一次搜索。
    fireEvent.change(input, { target: { value: "退" } });
    await waitFor(() => expect(getSearch).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    });
    expect(getSearch).toHaveBeenCalledWith({ q: "退", limit: 20 });
  });

  it("keeps only same-project TASK candidates and excludes the source task", async () => {
    const { api, getSearch } = createApi();
    mount({ api });
    openMainTaskDropdown();
    fireEvent.change(screen.getByLabelText(searchLabel), {
      target: { value: "退款" },
    });
    // 候选要等防抖 + 搜索返回后才渲染。按选项 title 断言而不是全屏文本：弹层挂在
    // body 上，而「当前任务」卡片里也有同一个标题，全屏查询会把卡片误判成候选。
    // 作用域必须在这之后重新取：空态（notFoundContent）与有候选时不是同一个 listbox
    // 节点，先按 role 抓到的旧节点在候选回来后就脱离了文档，导致永远查不到选项。
    const option = await screen.findByTitle("重复回调任务 A");
    expect(option).toBeInTheDocument();
    const listbox = within(
      option.closest(".ant-select-dropdown") as HTMLElement,
    );
    expect(listbox.queryByTitle("退款主任务")).toBeNull();
    expect(listbox.queryByTitle("其他项目任务")).toBeNull();
    expect(listbox.queryByTitle("退款模块")).toBeNull();
    expect(getSearch).toHaveBeenCalledWith({ q: "退款", limit: 20 });
  });

  it("submits with CSRF, idempotency key, branch kind and returns the group id", async () => {
    const { api, mergeTaskGroup, issueCsrfToken } = createApi();
    const { onMerged } = mount({ api });
    const user = userEvent.setup();
    openMainTaskDropdown();
    fireEvent.change(screen.getByLabelText(searchLabel), {
      target: { value: "退款" },
    });
    fireEvent.click(await screen.findByTitle("重复回调任务 A"));
    expect(selectedMainTaskText()).toBe("重复回调任务 A");
    await user.click(screen.getByRole("radio", { name: /历史分支/ }));
    await user.type(
      screen.getByLabelText("合并说明（选填）"),
      "  合并不删历史  ",
    );
    await user.click(screen.getByRole("button", { name: "确认合并" }));
    await waitFor(() =>
      expect(mergeTaskGroup).toHaveBeenCalledWith(
        {
          sourceTaskId: 101,
          mainTaskId: 102,
          sourceKind: "HISTORICAL",
          mergeNote: "合并不删历史",
        },
        {
          headers: {
            "x-csrf-token": "a".repeat(43),
            "Idempotency-Key": expect.any(String),
          },
        },
      ),
    );
    expect(issueCsrfToken).toHaveBeenCalledTimes(1);
    expect(onMerged).toHaveBeenCalledWith(7);
  });

  it("requires a selected main task before submitting", async () => {
    const { api, mergeTaskGroup } = createApi();
    mount({ api });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "确认合并" }));
    expect(
      await screen.findByText("请先搜索并选择主任务。"),
    ).toBeInTheDocument();
    expect(mergeTaskGroup).not.toHaveBeenCalled();
  });

  it("offers a rescan after a state conflict", async () => {
    const { api, getSearch, mergeTaskGroup } = createApi();
    mergeTaskGroup.mockRejectedValueOnce(
      new ApiError(409, {
        code: "TASK_GROUP_STATE_CONFLICT",
        message: "conflict",
        details: {},
        requestId: "request-id",
      }),
    );
    mount({ api });
    const user = userEvent.setup();
    openMainTaskDropdown();
    fireEvent.change(screen.getByLabelText(searchLabel), {
      target: { value: "退款" },
    });
    fireEvent.click(await screen.findByTitle("重复回调任务 A"));
    await user.click(screen.getByRole("button", { name: "确认合并" }));
    expect(
      await screen.findByText(/分支任务已属于其他聚合组/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新搜索" }));
    await waitFor(() => expect(getSearch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(selectedMainTaskText()).toBeNull());
  });
});
