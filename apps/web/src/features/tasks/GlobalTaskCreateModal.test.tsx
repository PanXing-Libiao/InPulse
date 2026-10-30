import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type InpulseApiClient } from "@generated/api";
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
  } as unknown as InpulseApiClient;

  return {
    client,
    createModuleTask,
    createTaskWithScope,
    addExternalLink: (
      client as unknown as { addExternalLink: ReturnType<typeof vi.fn> }
    ).addExternalLink,
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
