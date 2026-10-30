import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InpulseApiClient } from "@generated/api";
import { GlobalTaskCreateModal } from "./GlobalTaskCreateModal";

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
      activeFeatureCount: 5,
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
      activeFeatureCount: 1,
      openTaskCount: 0,
      completedTaskCount: 0,
    },
  },
] as const;

const modules = [
  {
    id: 11,
    projectId: 1,
    name: "访问控制",
    description: "说明",
    status: "ACTIVE",
    sortOrder: 0,
    archivedAt: null,
    rowVersion: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
] as const;

const features = [
  {
    id: 111,
    projectId: 1,
    moduleId: 11,
    name: "MFA 登录",
    description: "说明",
    status: "ACTIVE",
    archivedAt: null,
    rowVersion: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
  {
    id: 112,
    projectId: 1,
    moduleId: 11,
    name: "会话管理",
    description: "说明",
    status: "ACTIVE",
    archivedAt: null,
    rowVersion: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
] as const;

const members = [
  { id: 1, name: "陈晓", avatarUrl: null },
  { id: 2, name: "李雷", avatarUrl: null },
] as const;

interface Harness {
  readonly client: InpulseApiClient;
  readonly createTask: ReturnType<typeof vi.fn>;
  readonly createModuleTask: ReturnType<typeof vi.fn>;
  readonly addExternalLink: ReturnType<typeof vi.fn>;
  readonly assistTaskDraft: ReturnType<typeof vi.fn>;
  readonly onClose: () => void;
  readonly onCreated: (taskId: number) => void;
}

function harness(
  overrides: {
    readonly createTask?: () => Promise<unknown>;
    readonly addExternalLink?: () => Promise<unknown>;
  } = {},
): Harness {
  const createTask =
    overrides.createTask ??
    (() => Promise.resolve({ id: 901, code: "T-901", rowVersion: 1 }));
  const createModuleTask = vi.fn(() =>
    Promise.resolve({ id: 902, code: "T-902", rowVersion: 1 }),
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
        featureId: 111,
        featureName: "MFA 登录",
      },
      confidence: "HIGH",
      notes: [],
    }),
  );
  const onClose = vi.fn<() => void>(() => undefined);
  const onCreated = vi.fn<(taskId: number) => void>(() => undefined);

  const client = {
    createApiClient: undefined,
    issueCsrfToken: vi.fn(() =>
      Promise.resolve({ csrfToken: "csrf-token", expiresAt: "2026-09-01" }),
    ),
    listProjects: vi.fn(() => Promise.resolve({ items: [...projects] })),
    listModules: vi.fn(() => Promise.resolve({ items: [...modules] })),
    listFeatures: vi.fn(() => Promise.resolve({ items: [...features] })),
    listActiveProjectMembers: vi.fn(() =>
      Promise.resolve({ items: [...members] }),
    ),
    listModuleTaskAssignees: vi.fn(() =>
      Promise.resolve({ items: [...members] }),
    ),
    createTask: vi.fn(createTask),
    createModuleTask,
    addExternalLink: vi.fn(addExternalLink),
    listExternalLinks: vi.fn().mockResolvedValue({ rowVersion: 1, items: [] }),
    assistTaskDraft,
  } as unknown as InpulseApiClient;

  return {
    client,
    createTask: (client as unknown as { createTask: ReturnType<typeof vi.fn> })
      .createTask,
    createModuleTask,
    addExternalLink: (
      client as unknown as { addExternalLink: ReturnType<typeof vi.fn> }
    ).addExternalLink,
    assistTaskDraft,
    onClose,
    onCreated,
  };
}

function mount(
  test: Harness,
  props: {
    readonly preset?: {
      readonly projectId?: number;
      readonly moduleId?: number;
      readonly featureId?: number;
    };
    readonly lockedScope?: "FEATURE" | "MODULE";
  } = {},
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
        onClose={test.onClose}
        onCreated={test.onCreated}
        {...(props.preset ? { preset: props.preset } : {})}
        {...(props.lockedScope ? { lockedScope: props.lockedScope } : {})}
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

/** CalmSelect 交互：打开指派人下拉并点选成员（弹层项带 title 属性）。 */
async function pickAssignee(
  user: ReturnType<typeof userEvent.setup>,
  memberName: string,
) {
  await user.click(assigneeTrigger());
  await user.click(await screen.findByTitle(memberName));
}

/** CalmSelect 交互：打开任意标签的下拉并点选目标项（弹层项带 title 属性）。 */
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
  it("keeps the form gated until the task has a real project/module/feature home", async () => {
    const test = harness();
    mount(test);
    const user = userEvent.setup();

    const assignee = await screen.findByLabelText("指派给");
    expect(assignee).toBeDisabled();
    // 归属没选全之前成员请求本就不该发出，不能显示一直不变的加载提示。
    expect(screen.queryByText("正在加载项目成员…")).toBeNull();
    expect(screen.getByRole("button", { name: "创建任务" })).toBeDisabled();

    await pickOption(user, "所属项目", "InPulse 平台");
    await waitFor(() =>
      expect(screen.getByLabelText("所属模块")).toBeEnabled(),
    );
    await pickOption(user, "所属模块", "访问控制");
    await waitFor(() =>
      expect(screen.getByLabelText("所属功能")).toBeEnabled(),
    );

    // 归属尚未选到功能之前，指派人与提交按钮都不该解锁。
    expect(screen.getByLabelText("指派给")).toBeDisabled();

    await pickOption(user, "所属功能", "MFA 登录");
    await waitFor(() => expect(screen.getByLabelText("指派给")).toBeEnabled());
    await user.click(assigneeTrigger());
    expect(await screen.findByTitle("李雷")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建任务" })).toBeEnabled();
  });

  it("shows the member loading hint only while the request is in flight", async () => {
    const test = harness();
    const gate: { release: () => void } = { release: () => undefined };
    (
      test.client as unknown as {
        listActiveProjectMembers: () => Promise<unknown>;
      }
    ).listActiveProjectMembers = vi.fn(
      () =>
        new Promise((resolve) => {
          gate.release = () =>
            resolve({ items: members.map((item) => ({ ...item })) });
        }),
    );

    mount(test, { preset: { projectId: 1, moduleId: 11, featureId: 111 } });

    expect(await screen.findByText("正在加载项目成员…")).toBeInTheDocument();
    gate.release();
    await waitFor(() =>
      expect(screen.queryByText("正在加载项目成员…")).toBeNull(),
    );
    fireEvent.mouseDown(assigneeTrigger());
    expect(await screen.findByTitle("李雷")).toBeInTheDocument();
  });

  it("resets the dependent selections when the project changes", async () => {
    const test = harness();
    mount(test, { preset: { projectId: 1, moduleId: 11, featureId: 111 } });
    const user = userEvent.setup();

    const featureField = await screen.findByLabelText("所属功能");
    await waitFor(() =>
      expect(featureField.closest(".ant-select")).toHaveTextContent("MFA 登录"),
    );

    // 占位项已禁用，切换项目只能选另一个真实项目（2026-09-22 修复）。
    await pickOption(user, "所属项目", "订单中台");

    const moduleField = screen.getByLabelText("所属模块");
    await waitFor(() => expect(moduleField).not.toBeDisabled());
    expect(moduleField.closest(".ant-select")).toHaveTextContent("请选择模块");
    expect(screen.getByLabelText("所属功能")).toBeDisabled();
    expect(screen.getByLabelText("指派给")).toBeDisabled();
    expect(screen.getByRole("button", { name: "创建任务" })).toBeDisabled();
  });

  it("keeps the placeholder options unpickable", async () => {
    const test = harness();
    mount(test, { preset: { projectId: 1, moduleId: 11, featureId: 111 } });
    const user = userEvent.setup();

    const featureTrigger = () => {
      const trigger = screen.getByLabelText("所属功能").closest(".ant-select");
      if (!trigger) throw new Error("feature select not found");
      return trigger as HTMLElement;
    };
    await waitFor(() => expect(featureTrigger()).toHaveTextContent("MFA 登录"));

    // 「请选择功能」只是提示位：点它不会把已选功能清回未选择（2026-09-22 产品反馈）。
    await user.click(featureTrigger());
    const placeholder = await screen.findByTitle("请选择功能");
    expect(placeholder).toHaveClass("ant-select-item-option-disabled");
    await user.click(placeholder);
    expect(featureTrigger()).toHaveTextContent("MFA 登录");
  });

  it("creates a feature task with CSRF and an idempotency key, then closes", async () => {
    const test = harness();
    mount(test, { preset: { projectId: 1, moduleId: 11, featureId: 111 } });
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("任务标题"), "补齐恢复码入口");
    await waitFor(() => expect(screen.getByLabelText("指派给")).toBeEnabled());
    await pickAssignee(user, "李雷");
    await user.click(screen.getByRole("button", { name: "创建任务" }));

    await waitFor(() => expect(test.createTask).toHaveBeenCalledTimes(1));
    expect(test.createTask).toHaveBeenCalledWith(
      1,
      11,
      111,
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
    await waitFor(() => expect(test.onCreated).toHaveBeenCalledWith(901));
    expect(test.onClose).toHaveBeenCalled();
  });

  it("creates a module task with impact features and skips the feature selector", async () => {
    const test = harness();
    mount(test, { preset: { projectId: 1, moduleId: 11 } });
    const user = userEvent.setup();

    // 预置了模块则默认范围是模块级，此时不应该出现「所属功能」。
    expect(screen.queryByLabelText("所属功能")).toBeNull();

    await user.type(await screen.findByLabelText("任务标题"), "模块级任务");
    await waitFor(() => expect(screen.getByLabelText("指派给")).toBeEnabled());
    await pickAssignee(user, "陈晓");
    await pickOption(user, "影响功能", "会话管理");
    await user.click(screen.getByRole("button", { name: "创建任务" }));

    await waitFor(() => expect(test.createModuleTask).toHaveBeenCalledTimes(1));
    expect(test.createModuleTask).toHaveBeenCalledWith(
      1,
      11,
      {
        title: "模块级任务",
        description: "",
        priority: "NORMAL",
        assigneeIds: [1],
        dueAt: null,
        impactFeatureIds: [112],
      },
      {
        headers: {
          "x-csrf-token": "csrf-token",
          "Idempotency-Key": expect.stringMatching(/^task-/),
        },
      },
    );
  });

  it("locks the project and scope when the host page already fixed them", async () => {
    const test = harness();
    mount(test, {
      preset: { projectId: 1, moduleId: 11 },
      lockedScope: "MODULE",
    });

    // 页面已经固定归属：项目与模块都只回显名称，不再出现「所属项目」「所属模块」「任务范围」这三组选择器。
    // 弹层内容挂在 portal 上（不在 RTL 容器内），因此从 document 读取回显行。
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
    expect(await screen.findByLabelText("影响功能")).toBeEnabled();
  });

  it("reports the links that could not be attached without losing the task", async () => {
    const test = harness({
      addExternalLink: () => Promise.reject(new Error("rejected")),
    });
    mount(test, { preset: { projectId: 1, moduleId: 11, featureId: 111 } });
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
    expect(test.onCreated).toHaveBeenCalledWith(901);
    // 链接失败时保留弹窗与表单，用户可以直接复制链接或修改后重试。
    expect(test.onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("任务标题")).toHaveValue("带链接的任务");
  });

  it("blocks submission with an explicit reason instead of hitting the API", async () => {
    const test = harness();
    mount(test, { preset: { projectId: 1, moduleId: 11, featureId: 111 } });
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByLabelText("指派给")).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "创建任务" }));

    expect(await screen.findByText("请输入任务标题。")).toBeInTheDocument();
    expect(test.createTask).not.toHaveBeenCalled();
  });

  it("surfaces the server error text and keeps the draft", async () => {
    const test = harness({
      createTask: () =>
        Promise.reject(
          Object.assign(new Error("字段校验错误"), {
            name: "ApiError",
            status: 422,
          }),
        ),
    });
    mount(test, { preset: { projectId: 1, moduleId: 11, featureId: 111 } });
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("任务标题"), "重复标题");
    await waitFor(() => expect(screen.getByLabelText("指派给")).toBeEnabled());
    await pickAssignee(user, "陈晓");
    await user.click(screen.getByRole("button", { name: "创建任务" }));

    await waitFor(() => expect(test.createTask).toHaveBeenCalledTimes(1));
    expect(test.onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("任务标题")).toHaveValue("重复标题");
  });
});

it("在一次提交中创建自定义模块、功能和任务，并返回真实跳转位置", async () => {
  const test = harness();
  const createTaskWithScope = vi.fn().mockResolvedValue({
    projectId: 1,
    moduleId: 21,
    featureId: 211,
    taskId: 903,
  });
  Object.assign(test.client, { createTaskWithScope });
  mount(test, { preset: { projectId: 1 } });
  const user = userEvent.setup();
  await pickOption(user, "所属模块", "自定义 · 创建新模块");
  await user.type(screen.getByLabelText("新模块名称"), "新业务模块");
  await user.type(screen.getByLabelText("新功能名称"), "新业务功能");
  await user.type(screen.getByLabelText("任务标题"), "一起创建");
  await waitFor(() => expect(screen.getByLabelText("指派给")).toBeEnabled());
  await pickAssignee(user, "陈晓");
  await user.click(screen.getByRole("button", { name: "创建任务" }));
  await waitFor(() => expect(createTaskWithScope).toHaveBeenCalledTimes(1));
  expect(createTaskWithScope).toHaveBeenCalledWith(
    1,
    expect.objectContaining({
      module: { kind: "new", input: { name: "新业务模块", description: "" } },
      feature: {
        kind: "new",
        input: {
          name: "新业务功能",
          currentBehavior: "",
          acceptanceCriteria: "",
          tags: [],
        },
      },
      impactFeatureIds: [],
    }),
    expect.objectContaining({
      headers: expect.objectContaining({
        "Idempotency-Key": expect.any(String),
      }),
    }),
  );
  expect(test.createTask).not.toHaveBeenCalled();
  expect(test.createModuleTask).not.toHaveBeenCalled();
  await waitFor(() => expect(test.onCreated).toHaveBeenCalledWith(903));
});

it("AI 助手把识别结果填入左侧空字段", async () => {
  const test = harness();
  mount(test);
  const user = userEvent.setup();
  await pickOption(user, "所属项目", "InPulse 平台");
  await pickOption(user, "所属模块", "访问控制");
  await pickOption(user, "所属功能", "MFA 登录");

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

  await user.click(await screen.findByRole("button", { name: "填入左侧" }));
  expect(screen.getByLabelText("任务标题")).toHaveValue("修复 MFA 登录超时");
  expect(screen.getByLabelText("任务说明")).toHaveValue(
    "定位 MFA 登录偶发超时的原因并修复。",
  );
  expect(screen.getByLabelText("截止时间")).toHaveValue("2026-11-06T18:00");
  expect(screen.getByText(/已填入 5 项/)).toBeInTheDocument();
});

it("AI 不覆盖用户已经手填的标题", async () => {
  const test = harness();
  mount(test);
  const user = userEvent.setup();
  await pickOption(user, "所属项目", "InPulse 平台");
  await pickOption(user, "所属模块", "访问控制");
  await pickOption(user, "所属功能", "MFA 登录");

  await user.type(screen.getByLabelText("任务标题"), "我自己写的标题");
  await user.type(screen.getByLabelText("描述任务"), "修一下登录");
  await user.click(screen.getByTestId("task-draft-assist-send"));

  await user.click(await screen.findByRole("button", { name: "填入左侧" }));
  expect(screen.getByLabelText("任务标题")).toHaveValue("我自己写的标题");
  expect(screen.getByText(/未覆盖已有内容：标题/)).toBeInTheDocument();
});
