import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type InpulseApiClient } from "@generated/api";
import {
  clipboardWithChatScreenshot,
  stubClipboardImagePipeline,
} from "../common/assist-image.test-support";
import {
  GlobalTaskCreateModal,
  type GlobalTaskCreateModalProps,
} from "./GlobalTaskCreateModal";

const projects = [
  {
    id: 1,
    code: "INP",
    name: "InPulse 平台",
    description: "说明",
    status: "ACTIVE",
    rowVersion: 1,
    createdBy: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    memberCount: 4,
    stats: {
      activeModuleCount: 2,
      openTaskCount: 3,
      completedTaskCount: 1,
    },
  },
  {
    id: 2,
    code: "ORD",
    name: "订单中台",
    description: "说明",
    status: "ACTIVE",
    rowVersion: 1,
    createdBy: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    memberCount: 2,
    stats: {
      activeModuleCount: 1,
      openTaskCount: 0,
      completedTaskCount: 0,
    },
  },
] as const;

const modules = [
  {
    id: 11,
    projectId: 1,
    code: "INP-M-1",
    name: "访问控制",
    description: "说明",
    sortOrder: 0,
    rowVersion: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    stats: { openTaskCount: 0, completedTaskCount: 0 },
  },
] as const;

const members = [
  { id: 1, name: "陈晓", avatarUrl: null },
  { id: 2, name: "李雷", avatarUrl: null },
] as const;

const createdModuleTask = {
  id: 902,
  projectId: 1,
  moduleId: 11,
  code: "T-902",
  title: "补齐恢复码入口",
  description: "",
  assigneeId: 2,
  assigneeIds: [2],
  creatorId: 1,
  priority: "NORMAL",
  dueAt: null,
  workStatus: "TODO",
  lifecycleStatus: "ACTIVE",
  rowVersion: 1,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
} as const;

interface Harness {
  readonly client: InpulseApiClient;
  readonly createModuleTask: ReturnType<typeof vi.fn>;
  readonly createTaskWithScope: ReturnType<typeof vi.fn>;
  readonly addExternalLink: ReturnType<typeof vi.fn>;
  readonly assistTaskDraft: ReturnType<typeof vi.fn>;
  readonly assistTaskDraftStandalone: ReturnType<typeof vi.fn>;
  readonly onClose: ReturnType<typeof vi.fn>;
  readonly onCreated: ReturnType<typeof vi.fn>;
  readonly onCreatedLocation: ReturnType<typeof vi.fn>;
}

function harness(
  overrides: {
    readonly createModuleTask?: () => Promise<unknown>;
    readonly addExternalLink?: () => Promise<unknown>;
  } = {},
): Harness {
  const createModuleTask = vi.fn(
    overrides.createModuleTask ?? (() => Promise.resolve(createdModuleTask)),
  );
  const createTaskWithScope = vi.fn(() =>
    Promise.resolve({ projectId: 1, moduleId: 21, taskId: 903 }),
  );
  const addExternalLink =
    overrides.addExternalLink ?? (() => Promise.resolve({ linkId: 1 }));
  const assistTaskDraft = vi.fn(() =>
    Promise.resolve({
      reply: "识别到 3 项，截止和负责人请再确认。",
      draft: {
        title: "修复 MFA 登录超时",
        description: "定位 MFA 登录偶发超时的原因并修复。",
        priority: "HIGH",
        dueAt: "2026-11-06T18:00:00+08:00",
        assigneeIds: [1],
        assigneeNames: ["陈晓"],
        moduleId: 11,
        moduleName: "访问控制",
      },
      suggestions: {
        projects: [],
        modules: [{ id: 11, name: "访问控制" }],
      },
      confidence: "HIGH",
      notes: [],
    }),
  );
  const assistTaskDraftStandalone = vi.fn(() =>
    Promise.resolve({
      reply: "已按截图整理草稿；还没选项目，归属和负责人先留空。",
      draft: {
        title: "修复登录验证码弱网转圈",
        description:
          "定位登录页验证码在弱网下持续转圈、现场作业无法进入的问题。",
        priority: "HIGH",
        dueAt: null,
        assigneeIds: [],
        assigneeNames: [],
        moduleId: null,
        moduleName: null,
      },
      suggestions: { projects: [], modules: [] },
      confidence: "MEDIUM",
      notes: ["还没选项目，模块与负责人先留空"],
    }),
  );
  const onClose = vi.fn(() => undefined);
  const onCreated = vi.fn(() => undefined);
  const onCreatedLocation = vi.fn(() => undefined);

  const client = {
    issueCsrfToken: vi.fn(() =>
      Promise.resolve({ csrfToken: "csrf-token", expiresAt: "2026-09-01" }),
    ),
    listProjects: vi.fn(() => Promise.resolve({ items: [...projects] })),
    listModules: vi.fn(() => Promise.resolve({ items: [...modules] })),
    listActiveProjectMembers: vi.fn(() =>
      Promise.resolve({ items: [...members] }),
    ),
    createModuleTask,
    createTaskWithScope,
    addExternalLink: vi.fn(addExternalLink),
    listExternalLinks: vi.fn().mockResolvedValue({ rowVersion: 1, items: [] }),
    assistTaskDraft,
    assistTaskDraftStandalone,
  } as unknown as InpulseApiClient;

  return {
    client,
    createModuleTask,
    createTaskWithScope,
    addExternalLink: (
      client as unknown as { addExternalLink: ReturnType<typeof vi.fn> }
    ).addExternalLink,
    assistTaskDraft,
    assistTaskDraftStandalone,
    onClose,
    onCreated,
    onCreatedLocation,
  };
}

function mount(
  test: Harness,
  preset?: { readonly projectId?: number; readonly moduleId?: number },
) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <GlobalTaskCreateModal
        open
        client={test.client}
        onClose={
          test.onClose as unknown as GlobalTaskCreateModalProps["onClose"]
        }
        onCreated={
          test.onCreated as unknown as NonNullable<
            GlobalTaskCreateModalProps["onCreated"]
          >
        }
        onCreatedLocation={
          test.onCreatedLocation as unknown as GlobalTaskCreateModalProps["onCreatedLocation"]
        }
        {...(preset ? { preset } : {})}
      />
    </QueryClientProvider>,
  );
}

function assigneeTrigger(): HTMLElement {
  const trigger = screen.getByLabelText("指派给").closest(".ant-select");
  if (!trigger) {
    throw new Error("assignee select not found");
  }
  return trigger as HTMLElement;
}

async function pickAssignee(
  user: ReturnType<typeof userEvent.setup>,
  memberName: string,
) {
  await user.click(assigneeTrigger());
  await user.click(await screen.findByTitle(memberName));
}

async function pickOption(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  optionTitle: string,
) {
  const trigger = screen.getByLabelText(label).closest(".ant-select");
  if (!trigger) {
    throw new Error("select trigger not found for " + label);
  }
  await user.click(trigger as HTMLElement);
  await user.click(await screen.findByTitle(optionTitle));
}

describe("GlobalTaskCreateModal", () => {
  it("keeps the form gated until the task has a real project and module home", async () => {
    const test = harness();
    mount(test);
    const user = userEvent.setup();

    const assignee = await screen.findByLabelText("指派给");
    expect(assignee).toBeDisabled();
    expect(screen.getByLabelText("所属模块")).toBeDisabled();
    expect(screen.queryByText("正在加载项目成员…")).toBeNull();
    expect(screen.getByRole("button", { name: "创建任务" })).toBeDisabled();

    await pickOption(user, "所属项目", "InPulse 平台");
    await waitFor(() =>
      expect(screen.getByLabelText("所属模块")).toBeEnabled(),
    );
    expect(screen.getByLabelText("指派给")).toBeDisabled();
    expect(screen.getByRole("button", { name: "创建任务" })).toBeDisabled();

    await pickOption(user, "所属模块", "访问控制");
    await waitFor(() => expect(screen.getByLabelText("指派给")).toBeEnabled());
    await user.click(assigneeTrigger());
    expect(await screen.findByTitle("李雷")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建任务" })).toBeEnabled();
  });

  it("shows the member loading hint only while the request is in flight", async () => {
    const test = harness();
    let release: () => void = () => undefined;
    (
      test.client as unknown as {
        listActiveProjectMembers: () => Promise<unknown>;
      }
    ).listActiveProjectMembers = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ items: members.map((item) => ({ ...item })) });
        }),
    );

    mount(test, { projectId: 1, moduleId: 11 });

    expect(await screen.findByText("正在加载项目成员…")).toBeInTheDocument();
    release();
    await waitFor(() =>
      expect(screen.queryByText("正在加载项目成员…")).toBeNull(),
    );
    fireEvent.mouseDown(assigneeTrigger());
    expect(await screen.findByTitle("李雷")).toBeInTheDocument();
  });

  it("resets dependent selections when the project changes", async () => {
    const test = harness();
    mount(test, { projectId: 1 });
    const user = userEvent.setup();

    await pickOption(user, "所属模块", "访问控制");
    await waitFor(() => expect(screen.getByLabelText("指派给")).toBeEnabled());
    await pickOption(user, "所属项目", "订单中台");

    const moduleField = screen.getByLabelText("所属模块");
    await waitFor(() => expect(moduleField).not.toBeDisabled());
    expect(moduleField.closest(".ant-select")).toHaveTextContent("请选择模块");
    expect(screen.getByLabelText("指派给")).toBeDisabled();
    expect(screen.getByRole("button", { name: "创建任务" })).toBeDisabled();
  });

  it("keeps the module placeholder option unpickable", async () => {
    const test = harness();
    mount(test, { projectId: 1 });
    const user = userEvent.setup();

    await pickOption(user, "所属模块", "访问控制");
    const trigger = screen.getByLabelText("所属模块").closest(".ant-select");
    if (!trigger) throw new Error("module select not found");
    await user.click(trigger as HTMLElement);
    const placeholder = await screen.findByTitle("请选择模块");
    expect(placeholder).toHaveClass("ant-select-item-option-disabled");
    await user.click(placeholder);
    expect(trigger).toHaveTextContent("访问控制");
  });

  it("creates a module task with CSRF and an idempotency key, then closes", async () => {
    const test = harness();
    mount(test, { projectId: 1, moduleId: 11 });
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("任务标题"), "补齐恢复码入口");
    await waitFor(() => expect(screen.getByLabelText("指派给")).toBeEnabled());
    await pickAssignee(user, "李雷");
    await user.click(screen.getByRole("button", { name: "创建任务" }));

    await waitFor(() => expect(test.createModuleTask).toHaveBeenCalledTimes(1));
    expect(test.createModuleTask).toHaveBeenCalledWith(
      1,
      11,
      {
        title: "补齐恢复码入口",
        description: "",
        priority: "NORMAL",
        assigneeIds: [2],
        dueAt: null,
      },
      {
        headers: {
          "x-csrf-token": "csrf-token",
          "Idempotency-Key": expect.stringMatching(/^task-/),
        },
      },
    );
    await waitFor(() => expect(test.onCreated).toHaveBeenCalledWith(902));
    expect(test.onCreatedLocation).toHaveBeenCalledWith({
      projectId: 1,
      moduleId: 11,
      taskId: 902,
    });
    expect(test.onClose).toHaveBeenCalled();
  });

  it("locks the project and module when the host page already fixed them", async () => {
    const test = harness();
    mount(test, { projectId: 1, moduleId: 11 });

    await waitFor(() =>
      expect(
        [...document.querySelectorAll(".task-fixed-project")].map((row) =>
          row.textContent?.trim(),
        ),
      ).toEqual(["InPulse 平台", "访问控制"]),
    );
    expect(screen.queryByLabelText("所属项目")).toBeNull();
    expect(screen.queryByLabelText("所属模块")).toBeNull();
    expect(screen.queryAllByText("任务范围")).toHaveLength(0);
    expect(screen.queryByLabelText("所属功能")).toBeNull();
    expect(screen.queryByLabelText("影响功能")).toBeNull();
    expect(await screen.findByLabelText("指派给")).toBeEnabled();
  });

  it("reports links that could not be attached without losing the task", async () => {
    const test = harness({
      addExternalLink: () => Promise.reject(new Error("rejected")),
    });
    mount(test, { projectId: 1, moduleId: 11 });
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("任务标题"), "带链接的任务");
    await waitFor(() => expect(screen.getByLabelText("指派给")).toBeEnabled());
    await pickAssignee(user, "陈晓");
    await user.type(
      screen.getByLabelText("GitHub 链接"),
      "https://github.com/256-code/InPulse/pull/1",
    );
    await user.click(screen.getByRole("button", { name: "创建任务" }));

    await waitFor(() =>
      expect(
        screen.getByText(/任务已创建，但 1 个 GitHub 链接未能关联/),
      ).toBeInTheDocument(),
    );
    expect(test.onCreated).toHaveBeenCalledWith(902);
    expect(test.onCreatedLocation).not.toHaveBeenCalled();
    expect(test.onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("任务标题")).toHaveValue("带链接的任务");
  });

  it("blocks submission with an explicit reason instead of hitting the API", async () => {
    const test = harness();
    mount(test, { projectId: 1, moduleId: 11 });
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByLabelText("指派给")).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "创建任务" }));

    expect(await screen.findByText("请输入任务标题。")).toBeInTheDocument();
    expect(test.createModuleTask).not.toHaveBeenCalled();
  });

  it("surfaces the server error text and keeps the draft", async () => {
    const test = harness({
      createModuleTask: () =>
        Promise.reject(
          new ApiError(422, {
            code: "VALIDATION_ERROR",
            message: "字段校验错误",
            details: {},
            requestId: "test",
          }),
        ),
    });
    mount(test, { projectId: 1, moduleId: 11 });
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("任务标题"), "重复标题");
    await waitFor(() => expect(screen.getByLabelText("指派给")).toBeEnabled());
    await pickAssignee(user, "陈晓");
    await user.click(screen.getByRole("button", { name: "创建任务" }));

    await waitFor(() => expect(test.createModuleTask).toHaveBeenCalledTimes(1));
    expect(test.onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("任务标题")).toHaveValue("重复标题");
  });
});

it("creates a custom module and task in one submission and returns the real location", async () => {
  const test = harness();
  mount(test, { projectId: 1 });
  const user = userEvent.setup();
  await pickOption(user, "所属模块", "自定义 · 创建新模块");
  await user.type(screen.getByLabelText("新模块名称"), "新业务模块");
  await user.type(screen.getByLabelText("任务标题"), "一起创建");
  await waitFor(() => expect(screen.getByLabelText("指派给")).toBeEnabled());
  await pickAssignee(user, "陈晓");
  await user.click(screen.getByRole("button", { name: "创建任务" }));
  await waitFor(() =>
    expect(test.createTaskWithScope).toHaveBeenCalledTimes(1),
  );
  expect(test.createTaskWithScope).toHaveBeenCalledWith(
    1,
    {
      module: { kind: "new", input: { name: "新业务模块", description: "" } },
      task: {
        title: "一起创建",
        description: "",
        priority: "NORMAL",
        assigneeIds: [1],
        dueAt: null,
      },
    },
    expect.objectContaining({
      headers: expect.objectContaining({
        "Idempotency-Key": expect.any(String),
      }),
    }),
  );
  expect(test.createModuleTask).not.toHaveBeenCalled();
  await waitFor(() => expect(test.onCreated).toHaveBeenCalledWith(903));
  expect(test.onCreatedLocation).toHaveBeenCalledWith({
    projectId: 1,
    moduleId: 21,
    taskId: 903,
  });
});

it("AI 助手把识别结果填入左侧空字段", async () => {
  const test = harness();
  mount(test);
  const user = userEvent.setup();
  await pickOption(user, "所属项目", "InPulse 平台");

  await user.type(
    screen.getByLabelText("描述任务"),
    "周五前让陈晓修 MFA 登录超时",
  );
  await user.click(screen.getByTestId("task-draft-assist-send"));

  await waitFor(() => expect(test.assistTaskDraft).toHaveBeenCalledTimes(1));
  const call = test.assistTaskDraft.mock.calls[0] as
    [number, { message: string; history: readonly unknown[] }] | undefined;
  expect(call?.[0]).toBe(1);
  expect(call?.[1].message).toBe("周五前让陈晓修 MFA 登录超时");
  expect(call?.[1].history).toEqual([]);

  expect(
    await screen.findByText("像是「访问控制」这个模块，对吗？"),
  ).toBeInTheDocument();
  await user.click(await screen.findByRole("button", { name: "填入其余字段" }));
  expect(screen.getByLabelText("任务标题")).toHaveValue("修复 MFA 登录超时");
  expect(screen.getByLabelText("任务说明")).toHaveValue(
    "定位 MFA 登录偶发超时的原因并修复。",
  );
  expect(screen.getByLabelText("截止时间")).toHaveValue("2026-11-06T18:00");
  expect(
    screen.getByLabelText("所属模块").closest(".ant-select"),
  ).toHaveTextContent("请选择模块");
  expect(screen.getByText(/已填入 5 项/)).toBeInTheDocument();

  await user.click(await screen.findByRole("button", { name: "是，用这个" }));
  expect(
    screen.getByLabelText("所属模块").closest(".ant-select"),
  ).toHaveTextContent("访问控制");
  expect(screen.getByText("已确认模块：访问控制")).toBeInTheDocument();
});

it("AI 不覆盖用户已经手填的标题", async () => {
  const test = harness();
  mount(test);
  const user = userEvent.setup();
  await pickOption(user, "所属项目", "InPulse 平台");
  await pickOption(user, "所属模块", "访问控制");

  await user.type(screen.getByLabelText("任务标题"), "我自己写的标题");
  await user.type(screen.getByLabelText("描述任务"), "修一下登录");
  await user.click(screen.getByTestId("task-draft-assist-send"));

  await user.click(await screen.findByRole("button", { name: "填入其余字段" }));
  expect(screen.getByLabelText("任务标题")).toHaveValue("我自己写的标题");
  expect(screen.getByText(/未覆盖已有内容：标题/)).toBeInTheDocument();
});

it("项目简称只弹确认卡，确认后才切换左侧项目", async () => {
  const test = harness();
  test.assistTaskDraftStandalone.mockResolvedValueOnce({
    reply: "像是移动端那个项目；项目归属请你确认。",
    draft: {
      title: "修复登录验证码弱网转圈",
      description: "定位登录页验证码在弱网下持续转圈的问题。",
      priority: "HIGH",
      dueAt: null,
      assigneeIds: [],
      assigneeNames: [],
      moduleId: null,
      moduleName: null,
    },
    suggestions: {
      projects: [{ id: 2, code: "ORD", name: "订单中台" }],
      modules: [],
    },
    confidence: "MEDIUM",
    notes: ["未选择项目：项目归属请用确认卡或左侧下拉手动确定"],
  });
  mount(test);
  const user = userEvent.setup();

  await user.type(
    screen.getByLabelText("描述任务"),
    "就是之前说的那个订单项目，登录验证码一直转圈",
  );
  await user.click(screen.getByTestId("task-draft-assist-send"));

  expect(
    await screen.findByText("像是「订单中台」这个项目，是这个吗？"),
  ).toBeInTheDocument();
  const projectTrigger = screen
    .getByLabelText("所属项目")
    .closest(".ant-select");
  expect(projectTrigger).toHaveTextContent("请选择项目");
  expect(screen.getByLabelText("所属模块")).toBeDisabled();

  await user.click(screen.getByRole("button", { name: "是，用这个" }));

  await waitFor(() => expect(projectTrigger).toHaveTextContent("订单中台"));
  expect(screen.getByText("已确认项目：订单中台")).toBeInTheDocument();
  expect(screen.getByLabelText("所属模块")).toBeEnabled();
});

it("多个疑似项目时全部列出，点更改不替用户选择", async () => {
  const test = harness();
  test.assistTaskDraftStandalone.mockResolvedValueOnce({
    reply: "这个项目名有点模糊，可能是下面两个。",
    draft: {
      title: "检查登录验证码",
      description: "确认登录验证码转圈问题。",
      priority: "NORMAL",
      dueAt: null,
      assigneeIds: [],
      assigneeNames: [],
      moduleId: null,
      moduleName: null,
    },
    suggestions: {
      projects: [
        { id: 1, code: "INP", name: "InPulse 平台" },
        { id: 2, code: "ORD", name: "订单中台" },
      ],
      modules: [],
    },
    confidence: "LOW",
    notes: ["可能是这几个项目，请选一个"],
  });
  mount(test);
  const user = userEvent.setup();

  await user.type(screen.getByLabelText("描述任务"), "那个项目登录有问题");
  await user.click(screen.getByTestId("task-draft-assist-send"));

  expect(
    await screen.findByText("可能是这几个项目，选一个："),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "用「InPulse 平台」" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "用「订单中台」" }),
  ).toBeInTheDocument();

  await user.click(screen.getByTestId("task-assist-change-project"));
  const projectTrigger = screen
    .getByLabelText("所属项目")
    .closest(".ant-select");
  expect(projectTrigger).toHaveTextContent("请选择项目");
  expect(screen.getByText("项目归属请在左侧下拉选择")).toBeInTheDocument();
});

it("AI 助手支持只发聊天截图并把图片带给模型", async () => {
  const restore = stubClipboardImagePipeline();
  try {
    const test = harness();
    mount(test);
    const user = userEvent.setup();
    await pickOption(user, "所属项目", "InPulse 平台");

    fireEvent.paste(screen.getByLabelText("描述任务"), {
      clipboardData: clipboardWithChatScreenshot(),
    });

    await waitFor(() =>
      expect(screen.getByTestId("task-assist-attachments")).toBeInTheDocument(),
    );
    expect(screen.getByAltText("截图预览")).toBeInTheDocument();

    const send = screen.getByTestId("task-draft-assist-send");
    expect(send).toBeEnabled();
    await user.click(send);

    await waitFor(() => expect(test.assistTaskDraft).toHaveBeenCalledTimes(1));
    const payload = test.assistTaskDraft.mock.calls[0]?.[1] as
      | {
          message: string;
          images?: readonly { mimeType: string; data: string }[];
        }
      | undefined;
    expect(payload?.message).toBe("");
    expect(payload?.images).toEqual([{ mimeType: "image/jpeg", data: "AAAA" }]);
    expect(screen.getByText("（截图） · 1 张截图")).toBeInTheDocument();
  } finally {
    restore();
  }
});

it("未选项目也能先发描述识别，归属留空等用户补", async () => {
  const test = harness();
  mount(test);
  const user = userEvent.setup();

  await user.type(
    screen.getByLabelText("描述任务"),
    "李工说登录验证码一直转圈，优先处理",
  );
  const send = screen.getByTestId("task-draft-assist-send");
  expect(send).toBeEnabled();
  await user.click(send);

  await waitFor(() =>
    expect(test.assistTaskDraftStandalone).toHaveBeenCalledTimes(1),
  );
  expect(test.assistTaskDraft).not.toHaveBeenCalled();
  const payload = test.assistTaskDraftStandalone.mock.calls[0]?.[0] as
    { message: string } | undefined;
  expect(payload?.message).toContain("登录验证码");

  await user.click(await screen.findByRole("button", { name: "填入左侧" }));
  expect(screen.getByLabelText("任务标题")).toHaveValue(
    "修复登录验证码弱网转圈",
  );
  expect(screen.getAllByText(/还没选项目/).length).toBeGreaterThan(0);
});
