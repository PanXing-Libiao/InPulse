import React from "react";
import { ConfigProvider } from "antd";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { it, expect, vi } from "vitest";
import { ApiError, type InpulseApiClient } from "@generated/api";
import { ExternalLinksPanel } from "./ExternalLinksPanel";
const empty = { projectId: 1, rowVersion: 2, writable: true, items: [] };
function mount(api: InpulseApiClient) {
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <QueryClientProvider client={new QueryClient()}>
        <ExternalLinksPanel targetType="TASK" targetId={7} client={api} />
      </QueryClientProvider>
    </ConfigProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "GitHub 链接" }));
}

/** 弹层形态的写操作按需展开：先点「添加链接」，输入框才出现。 */
async function openAddForm() {
  fireEvent.click(await screen.findByRole("button", { name: "添加链接" }));
}
it("retains same semantic key after uncertain failure", async () => {
  const add = vi
    .fn()
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValue({ rowVersion: 3 });
  const api = {
    listExternalLinks: vi.fn().mockResolvedValue(empty),
    issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "x" }),
    addExternalLink: add,
  } as unknown as InpulseApiClient;
  mount(api);
  await openAddForm();
  fireEvent.change(screen.getByLabelText("GitHub URL"), {
    target: { value: "https://github.com/a/b/pull/7" },
  });
  fireEvent.click(screen.getByRole("button", { name: "确认添加" }));
  await screen.findByText(/输入已保留/);
  fireEvent.click(screen.getByRole("button", { name: "确认添加" }));
  await waitFor(() => expect(add).toHaveBeenCalledTimes(2));
  expect(add.mock.calls[0]![3].headers["Idempotency-Key"]).toBe(
    add.mock.calls[1]![3].headers["Idempotency-Key"],
  );
  expect(add.mock.calls[0]![3].headers["If-Match"]).toBe('"2"');
});
it("recognizes a bare commit SHA and previews the root-repository expansion", async () => {
  mount({
    listExternalLinks: vi.fn().mockResolvedValue(empty),
    issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "x" }),
    addExternalLink: vi.fn().mockResolvedValue({ rowVersion: 3 }),
  } as unknown as InpulseApiClient);
  await openAddForm();
  fireEvent.change(screen.getByLabelText("GitHub URL"), {
    target: { value: "408ADE2023DBDCAAE8FE7BFED7BDF2D759D71695" },
  });
  await waitFor(() =>
    expect(screen.getByText(/识别为：Commit 408ade2023db/)).toBeVisible(),
  );
  expect(screen.getByText(/将用项目根仓库补全为链接/)).toBeVisible();
});

it("explains the missing root repository when the server rejects a commit SHA", async () => {
  mount({
    listExternalLinks: vi.fn().mockResolvedValue(empty),
    issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "x" }),
    addExternalLink: vi.fn().mockRejectedValue(
      new ApiError(422, {
        code: "EXTERNAL_LINK_SHA_REQUIRES_ROOT_REPOSITORY",
        message: "no root",
        details: {},
        requestId: "r",
      }),
    ),
  } as unknown as InpulseApiClient);
  await openAddForm();
  fireEvent.change(screen.getByLabelText("GitHub URL"), {
    target: { value: "408ade2023dbdcaae8fe7bfed7bdf2d759d71695" },
  });
  fireEvent.click(screen.getByRole("button", { name: "确认添加" }));
  await waitFor(() =>
    expect(
      screen.getByText(
        "尚未设置项目根仓库，无法把 commit SHA 补全为链接；请先粘贴完整链接或设置项目根仓库。",
      ),
    ).toBeVisible(),
  );
});

it("409 refresh failure and closing never enable stale submission", async () => {
  const add = vi
    .fn()
    .mockRejectedValueOnce(
      new ApiError(409, {
        code: "EXTERNAL_LINK_VERSION_CONFLICT",
        message: "changed",
        details: {},
        requestId: "r",
      }),
    )
    .mockResolvedValue({ rowVersion: 5 });
  const list = vi
    .fn()
    .mockResolvedValueOnce(empty)
    .mockRejectedValueOnce(new Error("reload"))
    .mockResolvedValue({ ...empty, rowVersion: 4 });
  mount({
    listExternalLinks: list,
    addExternalLink: add,
    issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "x" }),
  } as unknown as InpulseApiClient);
  await openAddForm();
  fireEvent.change(screen.getByLabelText("GitHub URL"), {
    target: { value: "https://github.com/a/b" },
  });
  fireEvent.click(screen.getByRole("button", { name: "确认添加" }));
  await screen.findByRole("button", { name: "加载最新关联" });
  expect(screen.getByRole("button", { name: "确认添加" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "加载最新关联" }));
  await screen.findByText(/输入已保留/);
  expect(screen.getByRole("button", { name: "确认添加" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "关闭关联" }));
  fireEvent.click(screen.getByRole("button", { name: "GitHub 链接" }));
  expect(screen.getByRole("button", { name: "确认添加" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "加载最新关联" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "确认添加" })).toBeEnabled(),
  );
  expect(add).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "确认添加" }));
  await waitFor(() => expect(add).toHaveBeenCalledTimes(2));
  expect(add.mock.calls[1]![3].headers["If-Match"]).toBe('"4"');
  expect(add.mock.calls[1]![3].headers["Idempotency-Key"]).not.toBe(
    add.mock.calls[0]![3].headers["Idempotency-Key"],
  );
});
it("inline variant renders the github list in place, without a modal", async () => {
  const list = vi.fn().mockResolvedValue({
    projectId: 1,
    rowVersion: 4,
    writable: true,
    items: [
      {
        id: 9,
        projectId: 1,
        normalizedUrl: "https://github.com/a/b/pull/7",
        kind: "PULL_REQUEST",
        label: "a/b#7",
        repository: "a/b",
        externalNumber: "7",
        externalSha: null,
        releaseTag: null,
      },
    ],
  });
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <QueryClientProvider client={new QueryClient()}>
        <ExternalLinksPanel
          variant="inline"
          targetType="TASK"
          targetId={7}
          client={
            {
              listExternalLinks: list,
              issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "x" }),
            } as unknown as InpulseApiClient
          }
        />
      </QueryClientProvider>
    </ConfigProvider>,
  );
  const link = await screen.findByRole("link", { name: /a\/b#7/ });
  expect(link).toHaveAttribute("href", "https://github.com/a/b/pull/7");
  expect(screen.getByText("PR")).toBeVisible();
  expect(screen.getByText("7")).toBeVisible();
  expect(list).toHaveBeenCalledWith("TASK", 7);
  // 内联形态不打开弹层：没有弹层的关闭按钮，只有就地新增入口。
  expect(screen.queryByRole("button", { name: "关闭关联" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "添加 GitHub 链接" }),
  ).toBeEnabled();
  expect(screen.getByRole("button", { name: "解除 a/b#7" })).toBeEnabled();
});

it("explains an ordinary duplicate link without root repository wording", async () => {
  mount({
    listExternalLinks: vi.fn().mockResolvedValue(empty),
    issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "x" }),
    addExternalLink: vi.fn().mockRejectedValue(
      new ApiError(409, {
        code: "EXTERNAL_LINK_ALREADY_ASSOCIATED",
        message: "duplicate",
        details: {},
        requestId: "r",
      }),
    ),
  } as unknown as InpulseApiClient);
  await openAddForm();
  fireEvent.change(screen.getByLabelText("GitHub URL"), {
    target: { value: "https://github.com/a/b/pull/7" },
  });
  fireEvent.click(screen.getByRole("button", { name: "确认添加" }));
  await waitFor(() =>
    expect(screen.getByText("该链接已关联，请勿重复添加。")).toBeVisible(),
  );
  expect(screen.getByRole("button", { name: "确认添加" })).toBeDisabled();
});

it("keeps the add form collapsed until the add button is pressed", async () => {
  mount({
    listExternalLinks: vi.fn().mockResolvedValue({
      projectId: 1,
      rowVersion: 2,
      writable: true,
      items: [
        {
          id: 9,
          projectId: 1,
          normalizedUrl: "https://github.com/a/b/pull/7",
          kind: "PULL_REQUEST",
          label: "a/b#7",
          repository: "a/b",
          externalNumber: "7",
          externalSha: null,
          releaseTag: null,
          isRootRepository: false,
        },
      ],
    }),
    issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "x" }),
    addExternalLink: vi.fn().mockResolvedValue({ rowVersion: 3 }),
  } as unknown as InpulseApiClient);
  // 方案 A：默认态只有链接列表与「添加链接」，输入框按需展开。
  const firstItem = await screen.findByRole("link", { name: /a\/b#7/ });
  expect(screen.queryByLabelText("GitHub URL")).toBeNull();
  await openAddForm();
  const addBox = screen
    .getByLabelText("GitHub URL")
    .closest(".external-links-add");
  expect(addBox).not.toBeNull();
  // 展开后的表单排在链接列表之后（下半区追加式）。
  expect(
    addBox!.compareDocumentPosition(firstItem) &
      Node.DOCUMENT_POSITION_PRECEDING,
  ).toBeTruthy();
});

it("pins the project root repository above the link list for project targets", async () => {
  const api = {
    listExternalLinks: vi.fn().mockResolvedValue({
      projectId: 3,
      rowVersion: 5,
      writable: true,
      items: [
        {
          id: 1,
          projectId: 3,
          normalizedUrl: "https://github.com/a/root",
          kind: "OTHER",
          label: "a/root",
          repository: "a/root",
          externalNumber: null,
          externalSha: null,
          releaseTag: null,
          isRootRepository: true,
        },
        {
          id: 2,
          projectId: 3,
          normalizedUrl: "https://github.com/a/root/pull/7",
          kind: "PULL_REQUEST",
          label: "a/root#7",
          repository: "a/root",
          externalNumber: "7",
          externalSha: null,
          releaseTag: null,
          isRootRepository: false,
        },
      ],
    }),
    issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "x" }),
  } as unknown as InpulseApiClient;
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <QueryClientProvider client={new QueryClient()}>
        <ExternalLinksPanel targetType="PROJECT" targetId={3} client={api} />
      </QueryClientProvider>
    </ConfigProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "GitHub 链接" }));
  const rootCard = await screen.findByText("项目根仓库");
  const card = rootCard.closest(".external-links-root");
  expect(card).not.toBeNull();
  // 上半区是根仓库卡片：短标识 + 完整地址 + 「打开」入口 + 「切换」。
  expect(card!.textContent).toContain("a/root");
  expect(card!.textContent).toContain("https://github.com/a/root");
  expect(screen.getByRole("link", { name: /打开/ })).toHaveAttribute(
    "href",
    "https://github.com/a/root",
  );
  // 弹层有进场帧：可见性断言等动画落定，与文件内其他用例同一写法。
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "切换" })).toBeVisible(),
  );
  // 根仓库不再混进下半区列表，避免同一条链接出现两次。
  const list = document.querySelector(".external-links-list");
  expect(list).not.toBeNull();
  expect(list!.querySelectorAll("li")).toHaveLength(1);
  expect(list!.textContent).toContain("a/root#7");
});

it("marks aggregated project links with their sources and hides remove on foreign sources", async () => {
  const api = {
    listExternalLinks: vi.fn().mockResolvedValue({
      projectId: 3,
      rowVersion: 5,
      writable: true,
      items: [
        {
          id: 2,
          projectId: 3,
          normalizedUrl: "https://github.com/a/root/pull/7",
          kind: "PULL_REQUEST",
          label: "a/root#7",
          repository: "a/root",
          externalNumber: "7",
          externalSha: null,
          releaseTag: null,
          sources: [{ targetType: "PROJECT", targetId: 3, title: "测试项目" }],
        },
        {
          id: 4,
          projectId: 3,
          normalizedUrl:
            "https://github.com/a/root/commit/408ade2023dbdcaae8fe7bfed7bdf2d759d71695",
          kind: "COMMIT",
          label: "Commit 408ade2023db",
          repository: "a/root",
          externalNumber: null,
          externalSha: "408ade2023dbdcaae8fe7bfed7bdf2d759d71695",
          releaseTag: null,
          sources: [
            { targetType: "TASK", targetId: 21, title: "登录企业微信" },
            { targetType: "CHANGE_RECORD", targetId: 33, title: "发布验证" },
          ],
        },
      ],
    }),
    issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "x" }),
  } as unknown as InpulseApiClient;
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <QueryClientProvider client={new QueryClient()}>
        <ExternalLinksPanel targetType="PROJECT" targetId={3} client={api} />
      </QueryClientProvider>
    </ConfigProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "GitHub 链接" }));
  await waitFor(() =>
    expect(
      screen.getByText("任务「登录企业微信」、记录「发布验证」"),
    ).toBeVisible(),
  );
  expect(screen.getByText("本项目")).toBeVisible();
  // 解除只在仍有项目级关联时出现；任务 / 记录来源须回到各自入口。
  expect(screen.getAllByRole("button", { name: /^解除 / })).toHaveLength(1);
  expect(
    screen.queryByRole("button", { name: "解除 Commit 408ade2023db" }),
  ).toBeNull();
  expect(
    screen.getByText("来自任务 / 迭代记录的链接请在各自入口解除关联。"),
  ).toBeVisible();
});
