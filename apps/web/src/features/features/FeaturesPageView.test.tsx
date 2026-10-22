import React from "react";
import { ConfigProvider } from "antd";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type InpulseApiClient,
  type CurrentUserResponse,
  type FeatureItem,
  type ModuleItem,
} from "@generated/api";
import { FeaturesPageView } from "./FeaturesPageView";
import { AuthStateProvider } from "@features/auth/auth-context";

const item: FeatureItem = {
  id: 3,
  projectId: 2,
  name: "退款功能",
  currentBehavior: "",
  acceptanceCriteria: "",
  moduleId: 4,
  code: "PR-F-1",
  createdBy: 1,
  tags: [],
  rowVersion: 1,
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
  stats: { openTaskCount: 0, recordCount: 0, completedTaskCount: 0 },
};
/**
 * 功能视图会读模块列表用于项目内导航、读模块级任务用于页头计数；
 * 这里默认给空列表，需要断言导航的用例在传入的 client 上显式提供
 * listModules / listModuleTasks 覆盖即可。
 */
const withModules = (client: InpulseApiClient): InpulseApiClient =>
  Object.assign(
    {
      listModules: vi.fn().mockResolvedValue({ items: [] }),
      listModuleTasks: vi.fn().mockResolvedValue({ items: [] }),
      listModuleTaskAssignees: vi.fn().mockResolvedValue({ items: [] }),
    },
    client,
  ) as unknown as InpulseApiClient;

function mount(client: InpulseApiClient) {
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <AuthStateProvider>
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <MemoryRouter>
            <FeaturesPageView
              projectId={2}
              moduleId={4}
              client={withModules(client)}
            />
          </MemoryRouter>
        </QueryClientProvider>
      </AuthStateProvider>
    </ConfigProvider>,
  );
}
function mountDetail(client: InpulseApiClient, featureId: number) {
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <AuthStateProvider>
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <MemoryRouter>
            <FeaturesPageView
              projectId={2}
              moduleId={4}
              featureId={featureId}
              client={withModules(client)}
            />
          </MemoryRouter>
        </QueryClientProvider>
      </AuthStateProvider>
    </ConfigProvider>,
  );
}

/** 读取容器内每个徽章的 `badge-*` class，用于断言「同一文案全站同色」。 */
const badgeTones = (selector: string): string[] =>
  Array.from(document.querySelector(selector)?.children ?? []).map(
    (node) =>
      Array.from(node.classList).find((name) => name.startsWith("badge-")) ??
      "",
  );

describe("模块说明", () => {
  const moduleItem: ModuleItem = {
    code: "PR-M-4",
    id: 4,
    projectId: 2,
    name: "退款模块",
    description: "处理退款申请、审核和回调的模块说明。",
    kind: "NORMAL",
    sortOrder: 1,
    rowVersion: 1,
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
    stats: {
      activeFeatureCount: 0,
      openTaskCount: 0,
      completedTaskCount: 0,
    },
  };

  it("固定展示模块说明，不再使用折叠框", async () => {
    const client = {
      listModules: vi.fn().mockResolvedValue({ items: [moduleItem] }),
      listFeatures: vi.fn().mockResolvedValue({ items: [] }),
    } as unknown as InpulseApiClient;

    mount(client);

    await waitFor(() =>
      expect(document.querySelector(".module-description")).toHaveTextContent(
        moduleItem.description,
      ),
    );
    expect(screen.queryByRole("heading", { name: "模块说明" })).toBeNull();
    expect(document.querySelector("details.module-information")).toBeNull();
  });
});

describe("F-13 forms", () => {
  it("reuses the key for an uncertain retry and changes it when semantics change", async () => {
    const createFeature = vi.fn().mockRejectedValue(new Error("response lost"));
    const client = {
      listFeatures: vi.fn().mockResolvedValue({ items: [] }),
      findSimilarFeatures: vi.fn().mockResolvedValue({ items: [] }),
      issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "a".repeat(43) }),
      createFeature,
    } as unknown as InpulseApiClient;
    mount(client);
    await screen.findByText("暂无功能");
    fireEvent.click(screen.getByRole("button", { name: "新增功能" }));
    fireEvent.change(screen.getByLabelText("功能名称"), {
      target: { value: "退款" },
    });
    fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
    await screen.findByText("功能服务暂时不可用，请重试。");
    fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
    await waitFor(() => expect(createFeature).toHaveBeenCalledTimes(2));
    expect(createFeature.mock.calls[0]![3].headers["Idempotency-Key"]).toBe(
      createFeature.mock.calls[1]![3].headers["Idempotency-Key"],
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /保\s*存/ })).not.toHaveClass(
        "ant-btn-loading",
      ),
    );
    fireEvent.change(screen.getByLabelText("功能名称"), {
      target: { value: "退款回调" },
    });
    fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
    await waitFor(() => expect(createFeature).toHaveBeenCalledTimes(3));
    expect(createFeature.mock.calls[2]![3].headers["Idempotency-Key"]).not.toBe(
      createFeature.mock.calls[1]![3].headers["Idempotency-Key"],
    );
  });
  it("新增功能的标签用胶囊输入，回车添加后按数组提交", async () => {
    const createFeature = vi.fn().mockResolvedValue({ ...item, name: "退款" });
    const client = {
      listFeatures: vi.fn().mockResolvedValue({ items: [] }),
      findSimilarFeatures: vi.fn().mockResolvedValue({ items: [] }),
      issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "a".repeat(43) }),
      createFeature,
    } as unknown as InpulseApiClient;
    mount(client);
    await screen.findByText("暂无功能");
    fireEvent.click(screen.getByRole("button", { name: "新增功能" }));
    fireEvent.change(screen.getByLabelText("功能名称"), {
      target: { value: "退款" },
    });
    fireEvent.click(screen.getByRole("button", { name: "新标签" }));
    const entry = screen.getByLabelText<HTMLInputElement>("标签（最多 50 个）");
    fireEvent.change(entry, { target: { value: "支付" } });
    fireEvent.keyDown(entry, { key: "Enter" });
    fireEvent.change(entry, { target: { value: "退款" } });
    fireEvent.keyDown(entry, { key: "Enter" });
    expect(screen.getByText("支付")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
    await waitFor(() => expect(createFeature).toHaveBeenCalledTimes(1));
    expect(createFeature.mock.calls[0]![2]).toMatchObject({
      tags: ["支付", "退款"],
    });
    const toast = await screen.findByTestId("feature-operation-success");
    expect(toast).toHaveTextContent("功能操作成功");
    expect(toast).toHaveClass("success-toast");
    expect(toast.closest(".ant-alert")).toBeNull();
  });

  it("merges a name draft with a concurrently changed currentBehavior before using the latest version", async () => {
    const original = { ...item, currentBehavior: "编辑前说明" };
    const latest = {
      ...original,
      currentBehavior: "其他人更新的说明",
      acceptanceCriteria: "",
      tags: ["别人更新的标签"],
      rowVersion: 2,
    };
    const client = {
      listFeatures: vi
        .fn()
        .mockResolvedValueOnce({ items: [original] })
        .mockResolvedValue({ items: [latest] }),
      issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "a".repeat(43) }),
      updateFeature: vi
        .fn()
        .mockRejectedValueOnce(
          new ApiError(409, {
            code: "FEATURE_VERSION_CONFLICT",
            message: "版本冲突",
            details: {},
            requestId: "test",
          }),
        )
        .mockResolvedValue({ ...latest, name: "我的新名称", rowVersion: 3 }),
    } as unknown as InpulseApiClient;
    mount(client);
    fireEvent.click(await screen.findByRole("button", { name: "编辑功能" }));
    fireEvent.change(screen.getByLabelText("功能名称"), {
      target: { value: "我的新名称" },
    });
    fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
    await screen.findByText(/输入已保留/);
    fireEvent.click(
      screen.getByRole("button", { name: "加载最新版本后继续编辑" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("当前功能说明")).toHaveValue(
        "其他人更新的说明",
      ),
    );
    expect(screen.getByLabelText("功能名称")).toHaveValue("我的新名称");
    fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
    await waitFor(() => expect(client.updateFeature).toHaveBeenCalledTimes(2));
    expect(client.updateFeature).toHaveBeenLastCalledWith(
      2,
      4,
      3,
      {
        name: "我的新名称",
        currentBehavior: "其他人更新的说明",
        acceptanceCriteria: "",
        tags: ["别人更新的标签"],
      },
      expect.objectContaining({
        headers: expect.objectContaining({ "If-Match": '"2"' }),
      }),
    );
  });

  it.each(["我的", "最新"] as const)(
    "requires an explicit choice when both edit the same field: %s",
    async (choice) => {
      const original = { ...item, currentBehavior: "编辑前说明" };
      const latest = {
        ...original,
        currentBehavior: "其他人更新的说明",
        acceptanceCriteria: "",
        rowVersion: 2,
      };
      const client = {
        listFeatures: vi
          .fn()
          .mockResolvedValueOnce({ items: [original] })
          .mockResolvedValue({ items: [latest] }),
        issueCsrfToken: vi
          .fn()
          .mockResolvedValue({ csrfToken: "a".repeat(43) }),
        updateFeature: vi
          .fn()
          .mockRejectedValueOnce(
            new ApiError(409, {
              code: "FEATURE_VERSION_CONFLICT",
              message: "版本冲突",
              details: {},
              requestId: "test",
            }),
          )
          .mockResolvedValue({ ...latest, rowVersion: 3 }),
      } as unknown as InpulseApiClient;
      mount(client);
      fireEvent.click(await screen.findByRole("button", { name: "编辑功能" }));
      fireEvent.change(screen.getByLabelText("当前功能说明"), {
        target: { value: "我的说明草稿" },
      });
      fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
      await screen.findByText(/输入已保留/);
      fireEvent.click(
        screen.getByRole("button", { name: "加载最新版本后继续编辑" }),
      );
      await screen.findByText("当前功能说明存在冲突");
      expect(
        screen.getByText("编辑前说明", { exact: true }),
      ).toBeInTheDocument();
      expect(
        screen.getByText("我的说明草稿", { selector: "dd" }),
      ).toBeInTheDocument();
      expect(
        screen.getByText("其他人更新的说明", { selector: "dd" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /保\s*存/ })).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "应用合并结果" }),
      ).toBeDisabled();
      expect(client.updateFeature).toHaveBeenCalledTimes(1);
      fireEvent.click(
        screen.getByRole("button", {
          name:
            choice === "我的" ? "保留我的当前功能说明" : "采用最新当前功能说明",
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: "应用合并结果" }));
      const expectedDescription =
        choice === "我的" ? "我的说明草稿" : "其他人更新的说明";
      expect(screen.getByLabelText("当前功能说明")).toHaveValue(
        expectedDescription,
      );
      fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
      await waitFor(() =>
        expect(client.updateFeature).toHaveBeenCalledTimes(2),
      );
      expect(client.updateFeature).toHaveBeenLastCalledWith(
        2,
        4,
        3,
        {
          name: original.name,
          currentBehavior: expectedDescription,
          acceptanceCriteria: "",
          tags: [],
        },
        expect.objectContaining({
          headers: expect.objectContaining({ "If-Match": '"2"' }),
        }),
      );
    },
  );
  it("allows member editing and preserves input on 409 without admin buttons", async () => {
    const client = {
      listFeatures: vi.fn().mockResolvedValue({ items: [item] }),
      issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "a".repeat(43) }),
      updateFeature: vi.fn().mockRejectedValue(
        new ApiError(409, {
          code: "FEATURE_VERSION_CONFLICT",
          message: "冲突",
          details: {},
          requestId: "test",
        }),
      ),
    } as unknown as InpulseApiClient;
    mount(client);
    await screen.findByText("退款功能");
    expect(
      screen.queryByRole("button", { name: "归档功能" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑功能" }));
    fireEvent.change(screen.getByLabelText("功能名称"), {
      target: { value: "保留的新名称" },
    });
    fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
    await screen.findByText(/输入已保留/);
    expect(screen.getByLabelText("功能名称")).toHaveValue("保留的新名称");
    fireEvent.click(
      screen.getByRole("button", { name: "加载最新版本后继续编辑" }),
    );
    await waitFor(() => expect(client.listFeatures).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("功能名称")).toHaveValue("保留的新名称");
  });
  it("shows retry on list failure", async () => {
    const client = {
      listFeatures: vi
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValue({ items: [] }),
    } as unknown as InpulseApiClient;
    mount(client);
    fireEvent.click(await screen.findByRole("button", { name: /重\s*试/ }));
    await screen.findByText("暂无功能");
  });
});

describe("功能卡", () => {
  const withStats = {
    ...item,
    stats: { openTaskCount: 7, recordCount: 5, completedTaskCount: 7 },
  };
  const CardListRoute: React.FC = () => (
    <FeaturesPageView projectId={2} moduleId={4} client={cardClient} />
  );
  const cardClient = withModules({
    listFeatures: vi.fn().mockResolvedValue({ items: [withStats] }),
    findSimilarFeatures: vi.fn().mockResolvedValue({ items: [] }),
  } as unknown as InpulseApiClient);
  const mountCardList = () =>
    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <AuthStateProvider>
          <QueryClientProvider
            client={
              new QueryClient({ defaultOptions: { queries: { retry: false } } })
            }
          >
            <MemoryRouter initialEntries={["/projects/2/modules/4/features"]}>
              <Routes>
                <Route
                  path="/projects/:projectId/modules/:moduleId/features"
                  element={<CardListRoute />}
                />
                <Route
                  path="/projects/:projectId/modules/:moduleId/features/:featureId"
                  element={<div>功能详情页</div>}
                />
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>
        </AuthStateProvider>
      </ConfigProvider>,
    );

  it("shows the open task and iteration counts in the card footer", async () => {
    mountCardList();
    expect(await screen.findByText(/7 项待办/)).toBeInTheDocument();
    expect(screen.getByText(/5 条迭代/)).toBeInTheDocument();
  });

  it("opens the feature detail when the card body itself is clicked", async () => {
    mountCardList();
    fireEvent.click(await screen.findByRole("heading", { name: "退款功能" }));
    await screen.findByText("功能详情页");
  });

  it("keeps the card body as the only entry: no 查看详情 link inside", async () => {
    mountCardList();
    const card = (
      await screen.findByRole("heading", { name: "退款功能" })
    ).closest(".calm-feature-card");
    expect(card).not.toBeNull();
    // 整卡点击就是唯一入口，卡内不再有重复的链接或按钮。
    expect(within(card as HTMLElement).queryByRole("link")).toBeNull();
    expect(within(card as HTMLElement).queryByRole("button")).toBeNull();
  });

  it("档位只由已完成任务数推导，且不再有归档入口（ADR-045）", async () => {
    const api = withModules({
      listFeatures: vi.fn().mockResolvedValue({
        items: [
          {
            ...item,
            stats: {
              openTaskCount: 0,
              recordCount: 0,
              completedTaskCount: 0,
            },
          },
        ],
      }),
      findSimilarFeatures: vi.fn().mockResolvedValue({ items: [] }),
    } as unknown as InpulseApiClient);
    mount(api);
    await screen.findByRole("heading", { name: "退款功能" });
    // 功能层不再有归档：卡片上没有归档/恢复入口，也没有归档档位文案。
    expect(screen.queryByText("已归档")).toBeNull();
    expect(screen.queryByTestId("feature-lifecycle-3")).toBeNull();
    expect(screen.queryByRole("button", { name: "归档功能" })).toBeNull();
    expect(screen.queryByRole("button", { name: "恢复功能" })).toBeNull();
    // 档位只看「功能下有没有已完成任务」：0 项即未开始，用中性青。
    expect(screen.getByText("未开始")).toBeInTheDocument();
    expect(badgeTones(".task-card-badges")[0]).toBe("badge-cyan");
  });

  it("同一文案同色：功能卡与详情页头的「进行中」和自定义标签配色一致", async () => {
    const api = withModules({
      listFeatures: vi.fn().mockResolvedValue({
        items: [{ ...withStats, tags: ["校验", "实践"] }],
      }),
      findSimilarFeatures: vi.fn().mockResolvedValue({ items: [] }),
      getProject: vi
        .fn()
        .mockResolvedValue({ project: { id: 2, name: "项目" } }),
    } as unknown as InpulseApiClient);

    const card = mount(api);
    await screen.findByRole("heading", { name: "退款功能" });
    const cardTones = badgeTones(".task-card-badges");
    card.unmount();

    mountDetail(api, item.id);
    await screen.findByRole("heading", { name: "退款功能" });
    const detailTones = badgeTones(".task-modal-badges");

    // 同一个「进行中」在列表卡和详情页头都是蓝色，自定义标签在两处都是紫色。
    expect(cardTones).toEqual(["badge-blue", "badge-violet", "badge-violet"]);
    expect(detailTones.slice(0, cardTones.length)).toEqual(cardTones);
  });
});

it("功能详情：标签进标题行、验收标准排在功能任务之后", async () => {
  const api = {
    listFeatures: vi.fn().mockResolvedValue({
      items: [
        {
          ...item,
          currentBehavior: "退款回原支付渠道",
          acceptanceCriteria: "响应低于 500ms",
          tags: ["支付", "退款"],
        },
      ],
    }),
    getProject: vi.fn().mockResolvedValue({ project: { id: 2, name: "项目" } }),
  } as unknown as InpulseApiClient;
  mountDetail(api, item.id);

  // 功能说明只保留标题下方那一处，正文不再重复同名区块。
  expect(await screen.findByText("退款回原支付渠道")).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "当前功能说明" }),
  ).not.toBeInTheDocument();

  // 标签是标题行的小徽章，夹在状态与更新时间之间。
  await screen.findByText("退款回原支付渠道");
  const badgeRow = document.querySelector(".task-modal-badges");
  expect(badgeRow).not.toBeNull();
  const badges = Array.from(badgeRow?.children ?? []).map(
    (node) => node.textContent ?? "",
  );
  expect(badges.slice(-3)).toEqual([
    "支付",
    "退款",
    expect.stringContaining("更新"),
  ]);
  // 功能编号不在页头徽章行展示（仍保留在右侧「功能档案」里）。
  expect(badgeRow?.textContent ?? "").not.toContain(item.code);

  // 验收标准落在功能任务之后。
  const tasks = screen.getByRole("heading", { name: "功能任务" });
  const acceptance = screen.getByRole("heading", { name: "验收标准" });
  expect(
    tasks.compareDocumentPosition(acceptance) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

it("功能详情的更新时间按北京时间渲染", async () => {
  const api = {
    listFeatures: vi.fn().mockResolvedValue({
      items: [{ ...item, updatedAt: "2026-10-09T06:23:45.000Z" }],
    }),
    getProject: vi.fn().mockResolvedValue({ project: { id: 2, name: "项目" } }),
  } as unknown as InpulseApiClient;
  mountDetail(api, item.id);

  const badgeRow = await waitFor(() => {
    const node = document.querySelector(".task-modal-badges");
    expect(node).not.toBeNull();
    return node as Element;
  });
  // 06:23Z 是北京时间 14:23；直接切 ISO 串会显示成 06:23。
  expect(badgeRow.textContent).toContain("更新 2026-10-09 14:23");
});

it("功能概览显示验收标准，编辑时保留并提交", async () => {
  const updateFeature = vi.fn().mockResolvedValue({
    ...item,
    acceptanceCriteria: "响应低于 400ms",
    rowVersion: 2,
  });
  const api = {
    listFeatures: vi.fn().mockResolvedValue({
      items: [{ ...item, acceptanceCriteria: "响应低于 500ms" }],
    }),
    getProject: vi.fn().mockResolvedValue({ project: { id: 2, name: "项目" } }),
    issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "a".repeat(43) }),
    updateFeature,
  } as unknown as InpulseApiClient;
  mountDetail(api, item.id);
  expect(await screen.findByText("响应低于 500ms")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "编辑功能" }));
  const field = await screen.findByLabelText("验收标准（选填）");
  expect(field).toHaveValue("响应低于 500ms");
  fireEvent.change(field, { target: { value: "响应低于 400ms" } });
  fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
  await waitFor(() =>
    expect(updateFeature).toHaveBeenCalledWith(
      2,
      4,
      item.id,
      expect.objectContaining({ acceptanceCriteria: "响应低于 400ms" }),
      expect.anything(),
    ),
  );
});

describe("ADR-059 功能删除入口", () => {
  const member = (isAdmin: boolean): CurrentUserResponse => ({
    id: 7,
    loginName: isAdmin ? "tege" : "shaochenyu",
    name: isAdmin ? "管理员" : "邵晨宇",
    email: null,
    avatarUrl: null,
    isAdmin,
    status: "ACTIVE",
  });
  const detailItem: FeatureItem = {
    ...item,
    stats: { openTaskCount: 7, recordCount: 5, completedTaskCount: 7 },
  };
  const project = { id: 2, name: "项目" };
  /** 弹窗内部（编辑 / 删除入口）需要实时角色，因此这里显式给出认证态。 */
  const mountWith = (
    client: InpulseApiClient,
    options: { readonly isAdmin: boolean; readonly featureId?: number },
  ) =>
    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <AuthStateProvider
          value={{ status: "authenticated", user: member(options.isAdmin) }}
        >
          <QueryClientProvider
            client={
              new QueryClient({ defaultOptions: { queries: { retry: false } } })
            }
          >
            <MemoryRouter
              initialEntries={[
                options.featureId === undefined
                  ? "/projects/2/modules/4/features"
                  : "/projects/2/modules/4/features/" + options.featureId,
              ]}
            >
              <Routes>
                <Route
                  path="/projects/:projectId/modules/:moduleId/features"
                  element={
                    <FeaturesPageView
                      projectId={2}
                      moduleId={4}
                      client={withModules(client)}
                    />
                  }
                />
                <Route
                  path="/projects/:projectId/modules/:moduleId/features/:featureId"
                  element={
                    <FeaturesPageView
                      projectId={2}
                      moduleId={4}
                      featureId={options.featureId}
                      client={withModules(client)}
                    />
                  }
                />
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>
        </AuthStateProvider>
      </ConfigProvider>,
    );
  const projectClient = (overrides: Record<string, unknown>) =>
    ({
      listFeatures: vi.fn().mockResolvedValue({ items: [detailItem] }),
      getProject: vi
        .fn()
        .mockResolvedValue({ project, currentUserRole: "LEADER" }),
      issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "a".repeat(43) }),
      ...overrides,
    }) as unknown as InpulseApiClient;

  it("组长在编辑弹窗里按影响面确认后带 If-Match 删除功能", async () => {
    const deleteFeature = vi.fn().mockResolvedValue({ id: item.id });
    const api = projectClient({ deleteFeature });
    mountWith(api, { isAdmin: false });

    fireEvent.click(await screen.findByRole("button", { name: "编辑功能" }));
    const entry = await screen.findByRole("button", { name: "删除功能" });
    expect(entry.className).toContain("danger-button");
    fireEvent.click(entry);

    expect(await screen.findByText("确认删除功能")).toBeTruthy();
    expect(
      screen.getByText(/该功能下有 7 项未完成任务与 7 项已完成任务/),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("confirm-delete-feature"));

    await waitFor(() =>
      expect(deleteFeature).toHaveBeenCalledWith(
        2,
        4,
        3,
        { reason: null },
        {
          headers: {
            "x-csrf-token": "a".repeat(43),
            "Idempotency-Key": expect.stringMatching(/^feature-delete-/),
            "If-Match": '"1"',
          },
        },
      ),
    );
  });

  it("普通成员看不到删除入口，系统管理员可以删除", async () => {
    mountWith(
      projectClient({
        getProject: vi
          .fn()
          .mockResolvedValue({ project, currentUserRole: "MEMBER" }),
      }),
      { isAdmin: false },
    );
    fireEvent.click(await screen.findByRole("button", { name: "编辑功能" }));
    // 弹窗照常打开，只是没有删除入口。
    expect(await screen.findByRole("button", { name: /保\s*存/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "删除功能" })).toBeNull();

    cleanup();
    const adminApi = projectClient({
      getProject: vi.fn().mockResolvedValue({ project, currentUserRole: null }),
    });
    mountWith(adminApi, { isAdmin: true });
    fireEvent.click(await screen.findByRole("button", { name: "编辑功能" }));
    expect(
      await screen.findByRole("button", { name: "删除功能" }),
    ).toBeTruthy();
  });

  it("在功能详情里删除当前功能后退回功能列表", async () => {
    const deleteFeature = vi.fn().mockResolvedValue({ id: item.id });
    mountWith(projectClient({ deleteFeature }), {
      isAdmin: false,
      featureId: 3,
    });

    fireEvent.click(await screen.findByRole("button", { name: "编辑功能" }));
    fireEvent.click(await screen.findByRole("button", { name: "删除功能" }));
    fireEvent.click(await screen.findByTestId("confirm-delete-feature"));

    // 当前功能已经不存在，宿主页面必须退到功能列表：详情页头独有的返回按钮消失。
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "返回功能列表" })).toBeNull(),
    );
    expect(
      await screen.findByRole("button", { name: "编辑功能" }),
    ).toBeInTheDocument();
  });
});

describe("新项目搭建引导到达信号（2026-10-10）", () => {
  it("带 createFeature 信号进入功能页时自动打开「新增功能」弹窗", async () => {
    const client = {
      listFeatures: vi.fn().mockResolvedValue({ items: [] }),
      findSimilarFeatures: vi.fn().mockResolvedValue({ items: [] }),
    } as unknown as InpulseApiClient;
    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <AuthStateProvider>
          <QueryClientProvider
            client={
              new QueryClient({ defaultOptions: { queries: { retry: false } } })
            }
          >
            <MemoryRouter
              initialEntries={[
                {
                  pathname: "/projects/2/modules/4/features",
                  state: { createFeature: true },
                },
              ]}
            >
              <FeaturesPageView
                projectId={2}
                moduleId={4}
                client={withModules(client)}
              />
            </MemoryRouter>
          </QueryClientProvider>
        </AuthStateProvider>
      </ConfigProvider>,
    );
    expect(
      await screen.findByRole("dialog", { name: "新增功能" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("功能名称")).toHaveValue("");
  });

  it("没有到达信号时不会自动打开新建弹窗", async () => {
    const client = {
      listFeatures: vi.fn().mockResolvedValue({ items: [] }),
      findSimilarFeatures: vi.fn().mockResolvedValue({ items: [] }),
    } as unknown as InpulseApiClient;
    mount(client);
    await screen.findByText("暂无功能");
    expect(screen.queryByRole("dialog", { name: "新增功能" })).toBeNull();
  });
});
