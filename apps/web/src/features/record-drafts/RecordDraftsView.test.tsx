import React from "react";
import { ConfigProvider } from "antd";
import {
  render,
  screen,
  fireEvent,
  within,
  waitFor,
  act,
} from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi } from "vitest";
import {
  ApiError,
  type InpulseApiClient,
  type RecordDraftItem,
} from "@generated/api";
import { RecordDraftsView, mergeRecordDraft } from "./RecordDraftsView";
const item: RecordDraftItem = {
  id: 7,
  projectId: 1,
  moduleId: 2,
  taskId: null,
  authorId: 3,
  handlerId: 3,
  status: "DRAFT",
  code: null,
  currentVersion: 0,
  publishedAt: null,
  rowVersion: 1,
  createdAt: "2026-09-10T00:00:00.000Z",
  updatedAt: "2026-09-10T00:00:00.000Z",
  title: "支付修正",
  contextProblem: "重复请求",
  changeSolution: "增加幂等",
  resultVerification: "并发通过",
  remainingIssues: [],
};
function client(overrides: object = {}) {
  return {
    listProjects: vi.fn().mockResolvedValue({
      items: [{ id: 1, name: "支付项目", status: "ACTIVE" }],
    }),
    listModules: vi.fn().mockResolvedValue({
      items: [{ id: 2, name: "支付模块", status: "ACTIVE" }],
    }),
    listRecordDrafts: vi.fn().mockResolvedValue({
      items: [item],
      nextCursor: null,
      hasMore: false,
    }),
    listMyRecordDrafts: vi.fn().mockResolvedValue({
      items: [],
      nextCursor: null,
      hasMore: false,
    }),
    getRecordDraft: vi.fn().mockResolvedValue(item),
    issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "a".repeat(43) }),
    listExternalLinks: vi.fn().mockResolvedValue({
      projectId: 1,
      rowVersion: 1,
      writable: true,
      items: [],
    }),
    addExternalLink: vi.fn().mockResolvedValue({
      projectId: 1,
      targetType: "CHANGE_RECORD",
      targetId: 7,
      linkId: 1,
      rowVersion: 2,
    }),
    removeExternalLink: vi.fn().mockResolvedValue({
      projectId: 1,
      targetType: "CHANGE_RECORD",
      targetId: 7,
      linkId: 1,
      rowVersion: 2,
    }),
    ...overrides,
  } as unknown as InpulseApiClient;
}
function mountView(
  api: InpulseApiClient,
  path = "/records?projectId=1",
  currentUserId?: number,
  createToken = 0,
  onCanCreateChange?: (value: boolean) => void,
  currentUserName?: string,
) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <ConfigProvider theme={{ token: { motion: false } }}>
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <RecordDraftsView
            client={api}
            currentUserId={currentUserId}
            currentUserName={currentUserName}
            createToken={createToken}
            onCanCreateChange={onCanCreateChange}
          />
        </QueryClientProvider>
      </ConfigProvider>
    </MemoryRouter>
  );
}
function mount(
  api: InpulseApiClient,
  path = "/records?projectId=1",
  currentUserId?: number,
) {
  render(mountView(api, path, currentUserId));
}
/**
 * 受控草稿查询：先挂起、由测试决定何时解析，用来分别断言「首次加载中」与「解析为空」
 * 两种情形下草稿箱都不该出现任何字样。
 */
function deferredDrafts() {
  let resolve: (value: unknown) => void = () => {};
  const fn = vi.fn(
    () =>
      new Promise((res) => {
        resolve = res;
      }),
  );
  return { fn, resolve: (value: unknown) => resolve(value) };
}

/** CalmSelect 交互：在弹窗内打开下拉并点选目标项（弹层项挂在 body 上，带 title 属性）。 */
async function pickInModal(
  modal: ReturnType<typeof within>,
  label: string,
  optionTitle: string,
) {
  const trigger = modal.getByLabelText(label).closest(".ant-select");
  if (!trigger) {
    throw new Error("select trigger not found for " + label);
  }
  fireEvent.mouseDown(trigger);
  fireEvent.click(await screen.findByTitle(optionTitle));
}

describe("F-17 draft UI", () => {
  it("validates three sections and creates an independent draft through the client", async () => {
    const create = vi.fn().mockResolvedValue(item);
    const api = client({ createIndependentRecordDraft: create });
    const canCreate = vi.fn();
    const { rerender } = render(
      mountView(api, "/records?projectId=1", undefined, 0, canCreate),
    );
    // 新建入口已收到页头 CTA：等可写后再推进令牌，等价于点一次页头按钮。
    await waitFor(() => expect(canCreate).toHaveBeenLastCalledWith(true));
    rerender(mountView(api, "/records?projectId=1", undefined, 1, canCreate));
    const modal = within(
      await screen.findByRole("dialog", { name: "新建迭代记录" }),
    );
    await pickInModal(modal, "所属模块", "支付模块");
    fireEvent.click(modal.getByRole("button", { name: "保存草稿" }));
    await modal.findAllByText("请填写此项");
    expect(create).not.toHaveBeenCalled();
    for (const [label, value] of [
      ["迭代标题", item.title],
      ["改动原因", item.contextProblem],
      ["具体改动", item.changeSolution],
      ["改动效果", item.resultVerification],
    ])
      fireEvent.change(modal.getByLabelText(label!), { target: { value } });
    fireEvent.click(modal.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]![2]).toEqual({
      title: item.title,
      contextProblem: item.contextProblem,
      changeSolution: item.changeSolution,
      resultVerification: item.resultVerification,
      remainingIssues: [],
    });
    await waitFor(() =>
      expect(screen.getByText("暂无已知遗留问题")).toBeVisible(),
    );
  });
  it("does not expose the removed impact-feature selector in independent drafts", async () => {
    const api = client();
    const canCreate = vi.fn();
    const { rerender } = render(
      mountView(api, "/records?projectId=1", undefined, 0, canCreate),
    );
    await waitFor(() => expect(canCreate).toHaveBeenLastCalledWith(true));
    rerender(mountView(api, "/records?projectId=1", undefined, 1, canCreate));
    const modal = within(
      await screen.findByRole("dialog", { name: "新建迭代记录" }),
    );
    await pickInModal(modal, "所属模块", "支付模块");
    expect(modal.queryByLabelText("影响功能")).toBeNull();
  });

  it("shows the draft title in the modal header instead of repeating it in the body", async () => {
    mount(client(), "/records?projectId=1&recordId=7");
    const dialog = await screen.findByRole("dialog", { name: "草稿详情" });
    // 弹层标题是记录标题本身，眉标是「草稿」（同正式记录详情弹层的写法）。
    expect(
      await within(dialog).findByRole("heading", {
        name: "支付修正",
        level: 2,
      }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("草稿", { selector: ".detail-label" }),
    ).toBeInTheDocument();
    const detail = within(
      await screen.findByRole("region", { name: "草稿详情" }),
    );
    // 正文不再重复标题，也不再出现与弹层标题同级的第二个 h2。
    expect(detail.queryByRole("heading", { name: "支付修正" })).toBeNull();
    expect(detail.getByText(/记录作者/)).toBeInTheDocument();
    expect(
      detail.getByRole("heading", { name: "改动原因", level: 3 }),
    ).toBeInTheDocument();
  });
  it("preserves conflicting local content and requires a field choice before a new version", async () => {
    const update = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(409, {
          code: "RECORD_VERSION_CONFLICT",
          message: "版本变化",
          requestId: "test",
          details: {},
        }),
      )
      .mockResolvedValue({ ...item, rowVersion: 3 });
    const get = vi
      .fn()
      .mockResolvedValueOnce(item)
      .mockResolvedValue({
        ...item,
        rowVersion: 2,
        changeSolution: "其他成员方案",
      });
    mount(
      client({ getRecordDraft: get, updateIndependentRecordDraft: update }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /支付修正/ }));
    fireEvent.click(await screen.findByRole("button", { name: "继续编辑" }));
    const modal = within(
      await screen.findByRole("dialog", { name: "编辑草稿" }),
    );
    fireEvent.change(modal.getByLabelText("具体改动"), {
      target: { value: "我的方案" },
    });
    fireEvent.click(modal.getByRole("button", { name: "保存草稿" }));
    fireEvent.click(
      await modal.findByRole("button", { name: "加载最新草稿并合并" }),
    );
    expect(
      await modal.findByRole("button", { name: "应用合并" }),
    ).toBeDisabled();
    expect(modal.getByLabelText("具体改动")).toHaveValue("我的方案");
    await pickInModal(modal, "具体改动冲突", "保留我的输入");
    fireEvent.click(modal.getByRole("button", { name: "应用合并" }));
    fireEvent.click(modal.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[1]![2].changeSolution).toBe("我的方案");
    expect(update.mock.calls[1]![3].headers["If-Match"]).toBe('"2"');
  });
  it("merges disjoint changes without discarding local edits", () => {
    expect(
      mergeRecordDraft(
        item,
        { ...item, title: "我的标题" },
        { ...item, resultVerification: "新的验证" },
      ),
    ).toMatchObject({
      values: { title: "我的标题", resultVerification: "新的验证" },
      conflicts: [],
    });
  });
});
const source = {
  taskId: 8,
  projectId: 1,
  moduleId: 2,
  title: "来源标题",
  assigneeId: 9,
  workStatus: "TODO",
  lifecycleStatus: "ACTIVE",
  rowVersion: 4,
};
it("lists all source drafts without implicit selection and explicitly creates another with task version", async () => {
  const create = vi.fn().mockResolvedValue({ ...item, id: 10, taskId: 8 });
  const api = client({
    getTaskRecordDrafts: vi.fn().mockResolvedValue({
      source,
      items: [
        { ...item, taskId: 8 },
        { ...item, id: 9, taskId: 8, title: "另一草稿" },
      ],
    }),
    createTaskRecordDraft: create,
  });
  mount(api, "/records?projectId=1&moduleId=2&taskId=8");
  expect(
    await screen.findAllByRole("button", { name: /继续编辑/ }),
  ).toHaveLength(2);
  // 来源任务头部是卡片容器，新建按钮位于「来源草稿」标题行右侧而非裸排。
  expect(
    screen
      .getByRole("heading", { name: "来源标题", level: 2 })
      .closest(".draft-source-head"),
  ).not.toBeNull();
  expect(
    screen
      .getByRole("button", { name: "新建来源草稿" })
      .closest(".calm-section-title"),
  ).not.toBeNull();
  expect(
    screen.queryByRole("region", { name: "草稿详情" }),
  ).not.toBeInTheDocument();
  expect(create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "新建来源草稿" }));
  const modal = within(
    await screen.findByRole("dialog", { name: "新建任务迭代" }),
  );
  expect(modal.getByLabelText("迭代标题")).toHaveValue("来源标题");
  expect(modal.queryByLabelText("所属模块")).not.toBeInTheDocument();
  // 归属按来源快照只读展示（与迭代记录页同一套行），不是可编辑的选择器。
  const scopeFacts = modal.getByText("支付模块").closest(".record-scope-facts");
  expect(scopeFacts).not.toBeNull();
  expect(scopeFacts!.textContent).toContain("所属项目支付项目");
  expect(scopeFacts!.textContent).toContain("所属模块支付模块");
  // ADR-047：来源草稿也能就地发布；「保存草稿」退成淡蓝次级，主按钮是「发布迭代记录」。
  expect(modal.getByRole("button", { name: "发布迭代记录" })).toBeEnabled();
  expect(modal.getByRole("button", { name: "保存草稿" }).className).toContain(
    "soft-blue-button",
  );
  for (const label of ["改动原因", "具体改动", "改动效果"])
    fireEvent.change(modal.getByLabelText(label), {
      target: { value: "说明" },
    });
  fireEvent.click(modal.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  expect(create.mock.calls[0]!.slice(0, 4)).toEqual([
    1,
    2,
    8,
    {
      title: null,
      contextProblem: "说明",
      changeSolution: "说明",
      resultVerification: "说明",
      remainingIssues: [],
    },
  ]);
  expect(create.mock.calls[0]![4].headers["If-Match"]).toBe('"4"');
});
it("publishes a source draft in place while the source task stays unfinished", async () => {
  const create = vi.fn().mockResolvedValue({ ...item, id: 10, taskId: 8 });
  const publishChangeRecord = vi.fn().mockResolvedValue({
    ...item,
    id: 10,
    taskId: 8,
    rowVersion: 2,
    status: "PUBLISHED",
    code: "PAY-CR-1",
    currentVersion: 1,
    publishedAt: "2026-09-28T01:00:00.000Z",
  });
  const updateTaskRecordDraft = vi.fn();
  const api = client({
    getTaskRecordDrafts: vi.fn().mockResolvedValue({ source, items: [] }),
    createTaskRecordDraft: create,
    updateTaskRecordDraft,
    publishChangeRecord,
  });
  mount(api, "/records?projectId=1&moduleId=2&taskId=8");
  // 来源上下文解析前按钮是可写禁用的：等它可用再点，避免点空。
  const entry = await screen.findByRole("button", { name: "新建来源草稿" });
  await waitFor(() => expect(entry).toBeEnabled());
  fireEvent.click(entry);
  const modal = within(
    await screen.findByRole("dialog", { name: "新建任务迭代" }),
  );
  for (const [label, value] of [
    ["改动原因", "说明"],
    ["具体改动", "说明"],
    ["改动效果", "说明"],
  ])
    fireEvent.change(modal.getByLabelText(label!), { target: { value } });
  // 来源任务在 fixture 里仍是 TODO：发布入口不因完成状态被禁用。
  fireEvent.click(modal.getByRole("button", { name: "发布迭代记录" }));
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  await waitFor(() => expect(publishChangeRecord).toHaveBeenCalledOnce());
  // 发布用刚建出的草稿版本，而不是任务版本；也不写回任务。
  expect(publishChangeRecord.mock.calls[0]!.slice(0, 3)).toEqual([1, 10, {}]);
  expect(publishChangeRecord.mock.calls[0]![3].headers["If-Match"]).toBe('"1"');
  expect(updateTaskRecordDraft).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "新建任务迭代" })).toBeNull(),
  );
});
it("continues the selected source draft through the workflow without copying source fields", async () => {
  const draft = { ...item, taskId: 8 };
  const update = vi.fn().mockResolvedValue({ ...draft, rowVersion: 2 });
  const api = client({
    getTaskRecordDrafts: vi.fn().mockResolvedValue({ source, items: [draft] }),
    getRecordDraft: vi.fn().mockResolvedValue(draft),
    updateTaskRecordDraft: update,
  });
  mount(api, "/records?projectId=1&moduleId=2&taskId=8");
  fireEvent.click(await screen.findByRole("button", { name: /支付修正/ }));
  fireEvent.click(await screen.findByRole("button", { name: "继续编辑" }));
  const modal = within(await screen.findByRole("dialog", { name: "编辑草稿" }));
  fireEvent.click(modal.getByRole("button", { name: "添加遗留问题" }));
  fireEvent.change(modal.getByLabelText("遗留问题（选填，可添加多条） 1"), {
    target: { value: "补充" },
  });
  fireEvent.click(modal.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  expect(update.mock.calls[0]!.slice(0, 4)).toEqual([1, 2, 8, 7]);
  expect(update.mock.calls[0]![4]).toEqual({
    title: item.title,
    contextProblem: item.contextProblem,
    changeSolution: item.changeSolution,
    resultVerification: item.resultVerification,
    remainingIssues: [{ content: "补充" }],
  });
  expect(update.mock.calls[0]![5].headers["If-Match"]).toBe('"1"');
});

it("loads the next draft page with the server cursor", async () => {
  const nextItem = { ...item, id: 8, title: "第二页草稿" };
  const listRecordDrafts = vi
    .fn()
    .mockResolvedValueOnce({
      items: [item],
      nextCursor: "cursor-1",
      hasMore: true,
    })
    .mockResolvedValueOnce({
      items: [nextItem],
      nextCursor: null,
      hasMore: false,
    });
  mount(client({ listRecordDrafts }));
  expect(await screen.findByText("支付修正")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
  expect(await screen.findByText("第二页草稿")).toBeVisible();
  expect(listRecordDrafts).toHaveBeenLastCalledWith(
    1,
    { limit: 20, cursor: "cursor-1" },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

it("lists project drafts as flat cards and opens one straight away", async () => {
  mount(client());
  const cards = await screen.findAllByRole("button", { name: /继续编辑/ });
  expect(cards).toHaveLength(1);
  expect(within(cards[0]!).getByText("支付修正")).toBeVisible();
  // 卡片上不再有可见的「继续编辑 →」：整卡就是入口，动作名只留在无障碍名称里。
  expect(cards[0]).not.toHaveTextContent("继续编辑");
  expect(cards[0]).toHaveAccessibleName("继续编辑草稿：支付修正");
  fireEvent.click(cards[0]!);
  await waitFor(() =>
    expect(screen.getByRole("dialog", { name: "草稿详情" })).toBeVisible(),
  );
});
it("deletes the draft from the editor modal only after the destructive confirmation", async () => {
  const deleteRecordDraft = vi.fn().mockResolvedValue({
    projectId: 1,
    recordId: 7,
    moduleId: 2,
    taskId: null,
  });
  mount(client({ deleteRecordDraft }));
  fireEvent.click(await screen.findByRole("button", { name: /继续编辑/ }));
  fireEvent.click(await screen.findByRole("button", { name: "继续编辑" }));
  const modal = within(await screen.findByRole("dialog", { name: "编辑草稿" }));
  const deleteButton = modal.getByRole("button", { name: "删除草稿" });
  // 破坏性动作走 antd 的实底危险按钮（与「作废记录」「解除合并」同一套 danger + primary）。
  expect(deleteButton.className).toContain("ant-btn-dangerous");
  expect(deleteButton.className).toContain("ant-btn-primary");
  fireEvent.click(deleteButton);
  const confirm = within(
    await screen.findByRole("dialog", { name: "删除草稿" }),
  );
  // 删除不可恢复，确认弹层必须写清楚连带删掉的东西。
  // 弹层刚出现时还带 antd 的 appear 动画类（opacity 0），等它稳定再断言可见。
  await waitFor(() => expect(confirm.getByText(/不能恢复/)).toBeVisible());
  expect(deleteRecordDraft).not.toHaveBeenCalled();
  const confirmButton = confirm.getByRole("button", { name: "确认删除" });
  expect(confirmButton.className).toContain("ant-btn-dangerous");
  expect(confirmButton.className).toContain("ant-btn-primary");
  fireEvent.click(confirmButton);
  await waitFor(() => expect(deleteRecordDraft).toHaveBeenCalledOnce());
  expect(deleteRecordDraft.mock.calls[0]!.slice(0, 2)).toEqual([1, 7]);
  const init = deleteRecordDraft.mock.calls[0]![2];
  expect(init.headers["If-Match"]).toBe(
    String.fromCharCode(34) + "1" + String.fromCharCode(34),
  );
  expect(init.headers["x-csrf-token"]).toBe("a".repeat(43));
  expect(typeof init.headers["Idempotency-Key"]).toBe("string");
  // 删除成功后编辑弹窗与确认弹层一起关闭。
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "编辑草稿" })).toBeNull(),
  );
});
it("offers no delete action while the draft has not been saved yet", async () => {
  const canCreate = vi.fn();
  const { rerender } = render(
    mountView(client(), "/records?projectId=1", undefined, 0, canCreate),
  );
  await waitFor(() => expect(canCreate).toHaveBeenLastCalledWith(true));
  rerender(
    mountView(client(), "/records?projectId=1", undefined, 1, canCreate),
  );
  const modal = within(
    await screen.findByRole("dialog", { name: "新建迭代记录" }),
  );
  // 还没落库的草稿关掉弹窗就够了，没有可删的对象。
  expect(modal.queryByRole("button", { name: "删除草稿" })).toBeNull();
});
it("lists my drafts across projects, labels the owning project and opens it", async () => {
  const getRecordDraft = vi
    .fn()
    .mockResolvedValue({ ...item, id: 21, projectId: 5 });
  const listMyRecordDrafts = vi.fn().mockResolvedValue({
    items: [
      {
        draft: { ...item, id: 21, projectId: 5 },
        projectName: "风控项目",
        moduleName: "风控模块",
      },
    ],
    nextCursor: null,
    hasMore: false,
  });
  render(
    mountView(
      client({ listMyRecordDrafts, getRecordDraft }),
      "/records",
      3,
      0,
      undefined,
      "开发者 C",
    ),
  );
  // 全部项目视图也要展示草稿箱：标题变成跨项目汇总的「我的草稿」。
  expect(
    await screen.findByRole("heading", { name: "我的草稿" }),
  ).toBeVisible();
  // 用户截图 p2 指向的正是这条「我的草稿」副标题，已整条删除。
  expect(
    screen
      .getByRole("heading", { name: "我的草稿" })
      .closest(".calm-section-title")
      ?.querySelector("small"),
  ).toBeNull();
  expect(listMyRecordDrafts).toHaveBeenCalledWith(
    { limit: 20 },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  const card = await screen.findByRole("button", { name: /继续编辑/ });
  // 卡片带上草稿所属的项目名，避免跨项目视图里分不清归属。
  expect(within(card).getByText("风控项目 / 风控模块")).toBeVisible();
  // 服务端不回填作者名，用登录用户名兜底，而不是「名称暂不可用」。
  expect(card).toHaveTextContent("开发者 C");
  fireEvent.click(card);
  // 打开的是草稿自己的项目 + 记录，而不是 URL 里空缺的 projectId。
  expect(getRecordDraft).toHaveBeenCalledWith(
    5,
    21,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  await waitFor(() =>
    expect(screen.getByRole("dialog", { name: "草稿详情" })).toBeVisible(),
  );
});
it("saves the draft and publishes it when the new-iteration action is used", async () => {
  const create = vi.fn().mockResolvedValue({ ...item, id: 12, rowVersion: 1 });
  const publishChangeRecord = vi.fn().mockResolvedValue({
    ...item,
    id: 12,
    rowVersion: 2,
    status: "PUBLISHED",
    code: "PAY-CR-1",
    currentVersion: 1,
    publishedAt: "2026-09-10T01:00:00.000Z",
  });
  const api = client({
    createIndependentRecordDraft: create,
    publishChangeRecord,
  });
  const canCreate = vi.fn();
  const { rerender } = render(
    mountView(api, "/records?projectId=1", undefined, 0, canCreate),
  );
  await waitFor(() => expect(canCreate).toHaveBeenLastCalledWith(true));
  rerender(mountView(api, "/records?projectId=1", undefined, 1, canCreate));
  const modal = within(
    await screen.findByRole("dialog", { name: "新建迭代记录" }),
  );
  await pickInModal(modal, "所属模块", "支付模块");
  // 页脚两个动作：「保存草稿」退成淡蓝次级，右侧是主按钮「发布迭代记录」（三态统一文案）。
  expect(modal.getByRole("button", { name: "保存草稿" }).className).toContain(
    "soft-blue-button",
  );
  const publish = modal.getByRole("button", { name: "发布迭代记录" });
  expect(publish.className).toContain("primary-button");
  for (const [label, value] of [
    ["迭代标题", item.title],
    ["改动原因", item.contextProblem],
    ["具体改动", item.changeSolution],
    ["改动效果", item.resultVerification],
  ])
    fireEvent.change(modal.getByLabelText(label!), { target: { value } });
  fireEvent.click(publish);
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  await waitFor(() => expect(publishChangeRecord).toHaveBeenCalledOnce());
  // 发布必须带刚建出来的草稿版本：If-Match 用创建响应的 rowVersion。
  expect(publishChangeRecord.mock.calls[0]!.slice(0, 3)).toEqual([1, 12, {}]);
  const init = publishChangeRecord.mock.calls[0]![3];
  expect(init.headers["If-Match"]).toBe(
    String.fromCharCode(34) + "1" + String.fromCharCode(34),
  );
  expect(init.headers["x-csrf-token"]).toBe("a".repeat(43));
  expect(typeof init.headers["Idempotency-Key"]).toBe("string");
  // 发布成功直接落到正式记录：弹窗关闭且不会再打开草稿详情。
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "新建迭代记录" })).toBeNull(),
  );
  expect(screen.queryByRole("dialog", { name: "草稿详情" })).toBeNull();
});
it("publishes with the record version advanced by the links staged in the dialog", async () => {
  const create = vi.fn().mockResolvedValue({ ...item, id: 12, rowVersion: 1 });
  const publishChangeRecord = vi.fn().mockResolvedValue({
    ...item,
    id: 12,
    rowVersion: 3,
    status: "PUBLISHED",
    code: "PAY-CR-2",
    currentVersion: 1,
    publishedAt: "2026-09-28T01:00:00.000Z",
  });
  const addExternalLink = vi.fn().mockResolvedValue({
    projectId: 1,
    targetType: "CHANGE_RECORD",
    targetId: 12,
    linkId: 3,
    rowVersion: 2,
  });
  const api = client({
    createIndependentRecordDraft: create,
    publishChangeRecord,
    addExternalLink,
  });
  const canCreate = vi.fn();
  const { rerender } = render(
    mountView(api, "/records?projectId=1", undefined, 0, canCreate),
  );
  await waitFor(() => expect(canCreate).toHaveBeenLastCalledWith(true));
  rerender(mountView(api, "/records?projectId=1", undefined, 1, canCreate));
  const modal = within(
    await screen.findByRole("dialog", { name: "新建迭代记录" }),
  );
  await pickInModal(modal, "所属模块", "支付模块");
  for (const [label, value] of [
    ["迭代标题", item.title],
    ["改动原因", item.contextProblem],
    ["具体改动", item.changeSolution],
    ["改动效果", item.resultVerification],
  ])
    fireEvent.change(modal.getByLabelText(label!), { target: { value } });
  fireEvent.change(modal.getByLabelText("GitHub 链接地址"), {
    target: { value: "https://github.com/inpulse/inpulse/issues/9" },
  });
  fireEvent.click(modal.getByRole("button", { name: "添加链接" }));
  fireEvent.click(modal.getByRole("button", { name: "发布迭代记录" }));
  await waitFor(() => expect(publishChangeRecord).toHaveBeenCalledOnce());
  // 关联链接把记录版本从 1 推到 2：发布必须跟上最新版本，否则服务端 409。
  expect(publishChangeRecord.mock.calls[0]![3].headers["If-Match"]).toBe('"2"');
});
it("keeps the created draft and edits it in place when publishing fails", async () => {
  const create = vi.fn().mockResolvedValue({ ...item, id: 12, rowVersion: 1 });
  const update = vi.fn().mockResolvedValue({ ...item, id: 12, rowVersion: 2 });
  const publishChangeRecord = vi.fn().mockRejectedValue(
    new ApiError(422, {
      code: "RECORD_CONTENT_TOO_LARGE",
      message: "正文超出搜索容量",
      requestId: "test",
      details: {},
    }),
  );
  const api = client({
    createIndependentRecordDraft: create,
    updateIndependentRecordDraft: update,
    publishChangeRecord,
  });
  const canCreate = vi.fn();
  const { rerender } = render(
    mountView(api, "/records?projectId=1", undefined, 0, canCreate),
  );
  await waitFor(() => expect(canCreate).toHaveBeenLastCalledWith(true));
  rerender(mountView(api, "/records?projectId=1", undefined, 1, canCreate));
  const modal = within(
    await screen.findByRole("dialog", { name: "新建迭代记录" }),
  );
  await pickInModal(modal, "所属模块", "支付模块");
  for (const [label, value] of [
    ["迭代标题", item.title],
    ["改动原因", item.contextProblem],
    ["具体改动", item.changeSolution],
    ["改动效果", item.resultVerification],
  ])
    fireEvent.change(modal.getByLabelText(label!), { target: { value } });
  fireEvent.click(modal.getByRole("button", { name: "发布迭代记录" }));
  await waitFor(() => expect(publishChangeRecord).toHaveBeenCalledOnce());
  // 草稿已经落库：弹窗留在原地并切到这条草稿的编辑态，输入不丢。
  const retry = await modal.findByRole("button", { name: "发布迭代记录" });
  expect(modal.getByLabelText("迭代标题")).toHaveValue(item.title);
  fireEvent.click(retry);
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  // 重试走的是更新同一条草稿，没有第二条创建。
  expect(update.mock.calls[0]!.slice(0, 2)).toEqual([1, 12]);
  expect(update.mock.calls[0]![2].title).toBe(item.title);
  expect(create).toHaveBeenCalledOnce();
});
it("creates an independent draft in the project chosen inside the dialog from the all-projects view", async () => {
  const create = vi
    .fn()
    .mockResolvedValue({ ...item, id: 12, projectId: 2, moduleId: 9 });
  const listModules = vi.fn().mockResolvedValue({
    items: [{ id: 9, name: "风控模块", status: "ACTIVE" }],
  });
  const api = client({
    listProjects: vi.fn().mockResolvedValue({
      items: [
        { id: 1, name: "支付项目", status: "ACTIVE" },
        { id: 2, name: "风控项目", status: "ACTIVE" },
      ],
    }),
    listModules,
    createIndependentRecordDraft: create,
  });
  const canCreate = vi.fn();
  const { rerender } = render(mountView(api, "/records", 3, 0, canCreate));
  // 「全部项目」下只要存在可写项目就允许发起创建。
  await waitFor(() => expect(canCreate).toHaveBeenLastCalledWith(true));
  rerender(mountView(api, "/records", 3, 1, canCreate));
  const modal = within(
    await screen.findByRole("dialog", { name: "新建迭代记录" }),
  );
  // 未选项目前不请求模块，也不能提交。
  expect(listModules).not.toHaveBeenCalled();
  expect(modal.getByRole("button", { name: "保存草稿" })).toBeDisabled();
  await pickInModal(modal, "所属项目", "风控项目");
  // 项目确定后模块选项来自所选项目：打开下拉确认后点选。
  await pickInModal(modal, "所属模块", "风控模块");
  expect(listModules).toHaveBeenCalledWith(
    2,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  for (const [label, value] of [
    ["迭代标题", "风控修正"],
    ["改动原因", "说明"],
    ["具体改动", "说明"],
    ["改动效果", "说明"],
  ])
    fireEvent.change(modal.getByLabelText(label!), { target: { value } });
  fireEvent.click(modal.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  expect(create.mock.calls[0]!.slice(0, 2)).toEqual([2, 9]);
});

it("stages a GitHub link in the new-draft dialog and associates it after the draft is created", async () => {
  const create = vi.fn().mockResolvedValue({ ...item, id: 12 });
  const addExternalLink = vi.fn().mockResolvedValue({
    projectId: 1,
    targetType: "CHANGE_RECORD",
    targetId: 12,
    linkId: 3,
    rowVersion: 2,
  });
  const api = client({
    createIndependentRecordDraft: create,
    addExternalLink,
    listExternalLinks: vi.fn().mockResolvedValue({
      projectId: 1,
      rowVersion: 1,
      writable: true,
      items: [],
    }),
  });
  const canCreate = vi.fn();
  const { rerender } = render(
    mountView(api, "/records?projectId=1", undefined, 0, canCreate),
  );
  await waitFor(() => expect(canCreate).toHaveBeenLastCalledWith(true));
  rerender(mountView(api, "/records?projectId=1", undefined, 1, canCreate));
  const modal = within(
    await screen.findByRole("dialog", { name: "新建迭代记录" }),
  );
  await pickInModal(modal, "所属模块", "支付模块");
  // 非 github.com 的 HTTPS 链接不进待添加列表，只给可读错误。
  fireEvent.change(modal.getByLabelText("GitHub 链接地址"), {
    target: { value: "https://gitlab.com/inpulse/inpulse/pull/123" },
  });
  fireEvent.click(modal.getByRole("button", { name: "添加链接" }));
  expect(
    modal.getByText("只接受 github.com 的 HTTPS 链接，请检查输入。"),
  ).toBeInTheDocument();
  expect(addExternalLink).not.toHaveBeenCalled();
  // 合法链接先暂存并展示识别结果，草稿落库后才写入关联。
  fireEvent.change(modal.getByLabelText("GitHub 链接地址"), {
    target: { value: "https://github.com/inpulse/inpulse/pull/123" },
  });
  fireEvent.click(modal.getByRole("button", { name: "添加链接" }));
  expect(modal.getByText("PR #123")).toBeInTheDocument();
  for (const [label, value] of [
    ["迭代标题", item.title],
    ["改动原因", item.contextProblem],
    ["具体改动", item.changeSolution],
    ["改动效果", item.resultVerification],
  ])
    fireEvent.change(modal.getByLabelText(label!), { target: { value } });
  fireEvent.click(modal.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  await waitFor(() => expect(addExternalLink).toHaveBeenCalledOnce());
  expect(addExternalLink.mock.calls[0]!.slice(0, 3)).toEqual([
    "CHANGE_RECORD",
    12,
    { url: "https://github.com/inpulse/inpulse/pull/123" },
  ]);
  // 版本头用列表当前版本，幂等键是每次新生成的字符串。
  const init = addExternalLink.mock.calls[0]![3];
  expect(init.headers["If-Match"]).toBe('"1"');
  expect(typeof init.headers["Idempotency-Key"]).toBe("string");
  expect(init.headers["Idempotency-Key"].length).toBeGreaterThan(0);
  expect(init.headers["x-csrf-token"]).toBe("a".repeat(43));
});

it("saves the draft with Ctrl/Cmd + Enter and keeps a typed GitHub link", async () => {
  const create = vi.fn().mockResolvedValue({ ...item, id: 12 });
  const publishChangeRecord = vi.fn();
  const addExternalLink = vi.fn().mockResolvedValue({
    projectId: 1,
    targetType: "CHANGE_RECORD",
    targetId: 12,
    linkId: 3,
    rowVersion: 2,
  });
  const api = client({
    createIndependentRecordDraft: create,
    publishChangeRecord,
    addExternalLink,
  });
  const canCreate = vi.fn();
  const { rerender } = render(
    mountView(api, "/records?projectId=1", undefined, 0, canCreate),
  );
  await waitFor(() => expect(canCreate).toHaveBeenLastCalledWith(true));
  rerender(mountView(api, "/records?projectId=1", undefined, 1, canCreate));
  const modal = within(
    await screen.findByRole("dialog", { name: "新建迭代记录" }),
  );
  // 提交条件不满足时（还没选范围）按钮不可用，同一个快捷键也不得绕过去。
  fireEvent.keyDown(modal.getByLabelText("迭代标题"), {
    key: "Enter",
    ctrlKey: true,
  });
  expect(create).not.toHaveBeenCalled();
  await pickInModal(modal, "所属模块", "支付模块");
  for (const [label, value] of [
    ["迭代标题", item.title],
    ["改动原因", item.contextProblem],
    ["具体改动", item.changeSolution],
    ["改动效果", item.resultVerification],
  ])
    fireEvent.change(modal.getByLabelText(label!), { target: { value } });
  // 链接框里的回车仍然只暂存链接：Ctrl + Enter 也不会把刚输入的链接丢掉。
  fireEvent.change(modal.getByLabelText("GitHub 链接地址"), {
    target: { value: "https://github.com/inpulse/inpulse/pull/123" },
  });
  fireEvent.keyDown(modal.getByLabelText("GitHub 链接地址"), {
    key: "Enter",
    ctrlKey: true,
  });
  expect(create).not.toHaveBeenCalled();
  expect(modal.getByText("PR #123")).toBeInTheDocument();
  // 链接已暂存、输入框清空后，快捷键才落成「保存草稿」，且绝不触发发布。
  fireEvent.keyDown(modal.getByLabelText("GitHub 链接地址"), {
    key: "Enter",
    ctrlKey: true,
  });
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  await waitFor(() => expect(addExternalLink).toHaveBeenCalledOnce());
  expect(publishChangeRecord).not.toHaveBeenCalled();
});

it("closes an untouched dialog without asking about unsaved input", async () => {
  const create = vi.fn();
  const canCreate = vi.fn();
  const api = client({ createIndependentRecordDraft: create });
  const { rerender } = render(
    mountView(api, "/records?projectId=1", undefined, 0, canCreate),
  );
  await waitFor(() => expect(canCreate).toHaveBeenLastCalledWith(true));
  rerender(mountView(api, "/records?projectId=1", undefined, 1, canCreate));
  const modal = within(
    await screen.findByRole("dialog", { name: "新建迭代记录" }),
  );
  // 没改过任何字段：关闭不打扰，也不写库。
  fireEvent.click(modal.getByRole("button", { name: "关闭" }));
  expect(screen.queryByRole("dialog", { name: "放弃未保存的内容" })).toBeNull();
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "新建迭代记录" })).toBeNull(),
  );
  expect(create).not.toHaveBeenCalled();
});

it("asks before dropping unsaved input and never writes it on leave", async () => {
  const create = vi.fn();
  const canCreate = vi.fn();
  const api = client({ createIndependentRecordDraft: create });
  const { rerender } = render(
    mountView(api, "/records?projectId=1", undefined, 0, canCreate),
  );
  await waitFor(() => expect(canCreate).toHaveBeenLastCalledWith(true));
  rerender(mountView(api, "/records?projectId=1", undefined, 1, canCreate));
  const modal = within(
    await screen.findByRole("dialog", { name: "新建迭代记录" }),
  );
  fireEvent.change(modal.getByLabelText("改动原因"), {
    target: { value: "还没保存" },
  });
  // 未保存就关闭：先确认，输入原样留着。
  fireEvent.click(modal.getByRole("button", { name: "关闭" }));
  const discard = within(
    await screen.findByRole("dialog", { name: "放弃未保存的内容" }),
  );
  fireEvent.click(discard.getByRole("button", { name: "继续编辑" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "放弃未保存的内容" }),
    ).toBeNull(),
  );
  expect(modal.getByLabelText("改动原因")).toHaveValue("还没保存");
  expect(create).not.toHaveBeenCalled();
  // 放弃修改只是丢弃：草稿没有落库。
  fireEvent.click(modal.getByRole("button", { name: "关闭" }));
  fireEvent.click(
    within(
      await screen.findByRole("dialog", { name: "放弃未保存的内容" }),
    ).getByRole("button", { name: "放弃修改" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "新建迭代记录" })).toBeNull(),
  );
  expect(create).not.toHaveBeenCalled();
});

it("reports the header action as unavailable when every visible project is archived", async () => {
  const canCreate = vi.fn();
  const archived = client({
    listProjects: vi.fn().mockResolvedValue({
      items: [{ id: 1, name: "支付项目", status: "ARCHIVED" }],
    }),
  });
  render(mountView(archived, "/records", 3, 0, canCreate));
  await waitFor(() => expect(canCreate).toHaveBeenLastCalledWith(false));
});

it("空草稿箱整块不渲染：没有草稿时不留任何与草稿箱有关的字样", async () => {
  const pending = deferredDrafts();
  mount(client({ listRecordDrafts: pending.fn }));
  // 首次加载中还不知道有没有草稿，不抢先渲染标题行。
  expect(screen.queryByRole("heading", { name: "项目草稿" })).toBeNull();
  await act(async () => {
    pending.resolve({ items: [], nextCursor: null, hasMore: false });
  });
  // 解析为空后整块消失：标题、折叠按钮、内容区一个都不留。
  expect(screen.queryByRole("heading", { name: "项目草稿" })).toBeNull();
  expect(screen.queryByRole("button", { name: "收起草稿箱" })).toBeNull();
  expect(document.querySelector("#record-draft-list")).toBeNull();
});

it("全部项目视图的空草稿箱整块不渲染，连「我的草稿」标题也不出现", async () => {
  const pending = deferredDrafts();
  render(mountView(client({ listMyRecordDrafts: pending.fn }), "/records", 3));
  await act(async () => {
    pending.resolve({ items: [], nextCursor: null, hasMore: false });
  });
  expect(screen.queryByRole("heading", { name: "我的草稿" })).toBeNull();
  expect(screen.queryByRole("button", { name: "收起草稿箱" })).toBeNull();
  expect(document.querySelector("#record-draft-list")).toBeNull();
});

it("有草稿时默认展开，标题行的小按钮能把内容区折叠再展开", async () => {
  mount(client());
  expect(
    await screen.findByRole("heading", { name: "项目草稿" }),
  ).toBeVisible();
  const titleRow = screen
    .getByRole("heading", { name: "项目草稿" })
    .closest(".calm-section-title");
  // 说明文案整条删除：标题行里不再有 <small> 副标题。
  expect(titleRow?.querySelector("small")).toBeNull();
  const toggle = screen.getByRole("button", { name: "收起草稿箱" });
  // 展开/收起按钮紧贴标题（同一个标题行内的小组），不再被推到标题行最右端。
  expect(toggle.closest(".calm-section-title-head")).toBe(
    titleRow?.querySelector(".calm-section-title-head"),
  );
  // C 版：箭头紧贴标题，标题行里只有这一枚透明命中按钮，点它或点标题都能折叠。
  expect(titleRow?.querySelector(".draft-box-caret")).not.toBeNull();
  expect(titleRow?.querySelectorAll("button")).toHaveLength(1);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(toggle).toHaveAttribute("aria-controls", "record-draft-list");
  expect(
    await screen.findAllByRole("button", { name: /继续编辑/ }),
  ).toHaveLength(1);
  fireEvent.click(toggle);
  // 折叠只收内容：标题行与按钮留在原地，内容区与草稿卡片一起消失。
  expect(screen.getByRole("heading", { name: "项目草稿" })).toBeVisible();
  await waitFor(() =>
    expect(document.querySelector("#record-draft-list")).toBeNull(),
  );
  expect(screen.queryByRole("button", { name: /继续编辑/ })).toBeNull();
  const reopen = screen.getByRole("button", { name: "展开草稿箱" });
  expect(reopen).toHaveAttribute("aria-expanded", "false");
  expect(reopen).not.toHaveAttribute("aria-controls");
  fireEvent.click(reopen);
  expect(
    await screen.findAllByRole("button", { name: /继续编辑/ }),
  ).toHaveLength(1);
});

it("筛选项目时草稿箱跟着筛选：切到没有草稿的项目整块消失，切回后回到默认展开", async () => {
  const listRecordDrafts = vi.fn((projectId: number) =>
    Promise.resolve({
      items: projectId === 2 ? [] : [item],
      nextCursor: null,
      hasMore: false,
    }),
  );
  const listMyRecordDrafts = vi.fn().mockResolvedValue({
    items: [
      {
        draft: item,
        projectName: "支付项目",
        moduleName: "支付模块",
      },
    ],
    nextCursor: null,
    hasMore: false,
  });
  const api = client({ listRecordDrafts, listMyRecordDrafts });
  const router: { go: (path: string) => void } = { go: () => {} };
  function NavCapture() {
    const navigate = useNavigate();
    router.go = (path) => void navigate(path);
    return null;
  }
  render(
    <MemoryRouter initialEntries={["/records"]}>
      <ConfigProvider theme={{ token: { motion: false } }}>
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <NavCapture />
          <RecordDraftsView client={api} currentUserId={3} />
        </QueryClientProvider>
      </ConfigProvider>
    </MemoryRouter>,
  );
  // 全部项目：跨项目草稿箱默认展开，先手动收起。
  fireEvent.click(await screen.findByRole("button", { name: "收起草稿箱" }));
  await waitFor(() =>
    expect(document.querySelector("#record-draft-list")).toBeNull(),
  );
  // 切到没有草稿的项目 2：草稿箱整块消失，标题与折叠按钮一起走。
  await act(async () => {
    router.go("/records?projectId=2");
  });
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: "项目草稿" })).toBeNull(),
  );
  expect(screen.queryByRole("button", { name: "展开草稿箱" })).toBeNull();
  // 草稿查询跟着 URL 里的项目走，并且只看当前用户创建的草稿。
  expect(listRecordDrafts).toHaveBeenCalledWith(
    2,
    { limit: 20, authorId: 3 },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  // 切回全部项目：回到默认展开，不继承上一步的收起态。
  await act(async () => {
    router.go("/records");
  });
  expect(
    await screen.findAllByRole("button", { name: /继续编辑/ }),
  ).toHaveLength(1);
});

it("来源任务的空草稿箱收起，标题行的「新建来源草稿」入口保留", async () => {
  const api = client({
    getTaskRecordDrafts: vi.fn().mockResolvedValue({ source, items: [] }),
  });
  mount(api, "/records?projectId=1&moduleId=2&taskId=8");
  expect(
    await screen.findByRole("button", { name: "新建来源草稿" }),
  ).toBeVisible();
  await waitFor(() =>
    expect(document.querySelector("#record-draft-list")).toBeNull(),
  );
});

it("草稿读取失败时内容区仍然展开，保留错误与重试入口", async () => {
  mount(
    client({
      listRecordDrafts: vi
        .fn()
        .mockRejectedValue(new ApiError(500, { code: "boom" })),
    }),
  );
  expect(
    await screen.findByRole("button", { name: "重试草稿列表" }),
  ).toBeVisible();
  // 列表读取不涉及未提交输入，「输入已保留」在这里是误导。
  expect(screen.getByText("草稿服务暂时不可用，请重试。")).toBeVisible();
  expect(screen.queryByText(/输入已保留/)).not.toBeInTheDocument();
});

it("项目草稿读取 404 时整块不渲染，不留永远失败的重试入口", async () => {
  const listRecordDrafts = vi
    .fn()
    .mockRejectedValue(new ApiError(404, { code: "NOT_FOUND" }));
  mount(client({ listRecordDrafts }));
  await act(async () => {});
  expect(listRecordDrafts).toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "重试草稿列表" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "项目草稿" })).toBeNull();
  expect(screen.queryByText(/无权访问/)).not.toBeInTheDocument();
});
