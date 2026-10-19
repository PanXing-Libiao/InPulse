import React from "react";
import { describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ApiError,
  type CreateProjectResponse,
  type InpulseApiClient,
} from "@generated/api";
import { CreateProjectModal } from "./CreateProjectModal";

const createdProject: CreateProjectResponse = {
  project: {
    id: 7,
    code: "SHOP",
    name: "商城系统",
    description: "商城项目描述",
    status: "NOT_STARTED",
    rowVersion: 1,
    createdBy: 1,
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
  },
  members: [
    {
      userId: 1,
      status: "ACTIVE",
      role: "LEADER",
      joinedAt: "2026-09-09T00:00:00.000Z",
    },
  ],
};

function renderModal(client: InpulseApiClient) {
  const onCreated = vi.fn();
  const onClose = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false } },
        })
      }
    >
      <CreateProjectModal
        open
        creatorName="开发者 C"
        creatorUserId={1}
        client={client}
        onCreated={onCreated}
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
  return { onCreated, onClose };
}

async function fillForm(dialog: HTMLElement) {
  const user = userEvent.setup();
  await user.type(within(dialog).getByLabelText("项目名称"), "商城系统");
  await user.type(within(dialog).getByLabelText("项目编码"), "shop");
  await user.type(within(dialog).getByLabelText("项目描述"), "商城项目描述");
}

describe("CreateProjectModal", () => {
  it("submits normalized values with CSRF and idempotency headers", async () => {
    const issueCsrfToken = vi.fn().mockResolvedValue({ csrfToken: "csrf-1" });
    const getUserDirectory = vi.fn().mockResolvedValue({
      items: [{ id: 1, name: "开发者 C", avatarUrl: null, isAdmin: false }],
    });
    const createProject = vi.fn().mockResolvedValue(createdProject);
    const client = {
      issueCsrfToken,
      getUserDirectory,
      createProject,
    } as unknown as InpulseApiClient;
    const { onCreated, onClose } = renderModal(client);

    const dialog = await screen.findByRole("dialog", { name: "新建项目" });
    await fillForm(dialog);
    const user = userEvent.setup();
    await user.click(within(dialog).getByRole("button", { name: "创建项目" }));

    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    expect(createProject).toHaveBeenCalledWith(
      {
        name: "商城系统",
        code: "SHOP",
        description: "商城项目描述",
        memberIds: [],
      },
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-csrf-token": "csrf-1",
          "Idempotency-Key": expect.any(String),
        }),
      }),
    );
    expect(onCreated).toHaveBeenCalledWith(createdProject);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows a 409 message without calling the success callback", async () => {
    const issueCsrfToken = vi.fn().mockResolvedValue({ csrfToken: "csrf-1" });
    const getUserDirectory = vi.fn().mockResolvedValue({
      items: [{ id: 1, name: "开发者 C", avatarUrl: null, isAdmin: false }],
    });
    const createProject = vi.fn().mockRejectedValue(
      new ApiError(409, {
        code: "PROJECT_BOOTSTRAP_CONFLICT",
        message: "internal-conflict-message",
        details: {},
        requestId: "request-1",
      }),
    );
    const client = {
      issueCsrfToken,
      getUserDirectory,
      createProject,
    } as unknown as InpulseApiClient;
    const { onCreated, onClose } = renderModal(client);

    const dialog = await screen.findByRole("dialog", { name: "新建项目" });
    await fillForm(dialog);
    const user = userEvent.setup();
    await user.click(within(dialog).getByRole("button", { name: "创建项目" }));

    expect(
      await screen.findByText(
        "项目编码已存在或创建请求发生冲突，请刷新后重试。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("internal-conflict-message"),
    ).not.toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("sends several selected active members while excluding the creator", async () => {
    const issueCsrfToken = vi.fn().mockResolvedValue({ csrfToken: "csrf-1" });
    const getUserDirectory = vi.fn().mockResolvedValue({
      items: [
        { id: 1, name: "开发者 C", avatarUrl: null, isAdmin: false },
        { id: 2, name: "开发者 B", avatarUrl: null, isAdmin: false },
        { id: 3, name: "管理员 A", avatarUrl: null, isAdmin: true },
      ],
    });
    const createProject = vi.fn().mockResolvedValue(createdProject);
    const client = {
      issueCsrfToken,
      getUserDirectory,
      createProject,
    } as unknown as InpulseApiClient;
    const { onCreated, onClose } = renderModal(client);

    const dialog = await screen.findByRole("dialog", { name: "新建项目" });
    await fillForm(dialog);
    const user = userEvent.setup();
    const trigger = within(dialog)
      .getByLabelText("选择项目成员")
      .closest(".ant-select");
    expect(trigger).not.toBeNull();
    fireEvent.mouseDown(trigger as HTMLElement);
    fireEvent.click(await screen.findByTitle("开发者 B"));
    fireEvent.click(await screen.findByTitle("管理员 A"));
    await expect(
      within(dialog).findByText(/共 3 人/),
    ).resolves.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "创建项目" }));

    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    expect(createProject).toHaveBeenCalledWith(
      expect.objectContaining({ memberIds: [2, 3] }),
      expect.any(Object),
    );
    expect(onCreated).toHaveBeenCalledWith(createdProject);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("按组织整组选择：点组织按钮整组加入，再点整组移除并提交", async () => {
    const issueCsrfToken = vi.fn().mockResolvedValue({ csrfToken: "csrf-1" });
    const getUserDirectory = vi.fn().mockResolvedValue({
      items: [
        {
          id: 1,
          name: "开发者 C",
          avatarUrl: null,
          isAdmin: false,
          organizationId: 7,
          organizationName: "研发一组",
        },
        {
          id: 2,
          name: "开发者 B",
          avatarUrl: null,
          isAdmin: false,
          organizationId: 7,
          organizationName: "研发一组",
        },
        {
          id: 3,
          name: "开发者 D",
          avatarUrl: null,
          isAdmin: false,
          organizationId: 7,
          organizationName: "研发一组",
        },
        {
          id: 4,
          name: "管理员 A",
          avatarUrl: null,
          isAdmin: true,
          organizationId: null,
          organizationName: null,
        },
      ],
    });
    const createProject = vi.fn().mockResolvedValue(createdProject);
    const client = {
      issueCsrfToken,
      getUserDirectory,
      createProject,
    } as unknown as InpulseApiClient;
    renderModal(client);

    const dialog = await screen.findByRole("dialog", { name: "新建项目" });
    await fillForm(dialog);
    const groupButton = await within(dialog).findByRole("button", {
      name: /全选组织 研发一组/,
    });
    // 创建者被排除：研发一组的候选只剩 2、3 两人。
    expect(within(groupButton).getByText("0/2")).toBeInTheDocument();
    // 未分配不是小组，整组选择只列真实组织。
    expect(
      within(dialog).queryByRole("button", { name: /全选组织 未分配/ }),
    ).not.toBeInTheDocument();

    fireEvent.click(groupButton);
    await expect(
      within(dialog).findByText(/共 3 人/),
    ).resolves.toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: /取消全选组织 研发一组/ }),
    ).toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole("button", { name: /取消全选组织 研发一组/ }),
    );
    await expect(
      within(dialog).findByText(/共 1 人/),
    ).resolves.toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole("button", { name: /全选组织 研发一组/ }),
    );
    const user = userEvent.setup();
    await user.click(within(dialog).getByRole("button", { name: "创建项目" }));

    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    expect(createProject).toHaveBeenCalledWith(
      expect.objectContaining({ memberIds: [2, 3] }),
      expect.any(Object),
    );
  });

  it("组内可单独挑选：单人勾选后组织按钮显示已选进度", async () => {
    const getUserDirectory = vi.fn().mockResolvedValue({
      items: [
        {
          id: 1,
          name: "开发者 C",
          avatarUrl: null,
          isAdmin: false,
          organizationId: 7,
          organizationName: "研发一组",
        },
        {
          id: 2,
          name: "开发者 B",
          avatarUrl: null,
          isAdmin: false,
          organizationId: 7,
          organizationName: "研发一组",
        },
        {
          id: 3,
          name: "开发者 D",
          avatarUrl: null,
          isAdmin: false,
          organizationId: 7,
          organizationName: "研发一组",
        },
      ],
    });
    const client = { getUserDirectory } as unknown as InpulseApiClient;
    renderModal(client);

    const dialog = await screen.findByRole("dialog", { name: "新建项目" });
    await screen.findByRole("button", { name: /全选组织 研发一组/ });
    const trigger = within(dialog)
      .getByLabelText("选择项目成员")
      .closest(".ant-select");
    expect(trigger).not.toBeNull();
    fireEvent.mouseDown(trigger as HTMLElement);
    fireEvent.click(await screen.findByTitle("开发者 B"));

    await expect(
      within(dialog).findByText(/共 2 人/),
    ).resolves.toBeInTheDocument();
    const groupButton = within(dialog).getByRole("button", {
      name: /全选组织 研发一组（已选 1\/2 人）/,
    });
    expect(groupButton.className).toContain("is-partial");
    expect(within(groupButton).getByText("1/2")).toBeInTheDocument();
  });

  it("shows the creator as a locked member and counts it in the label", async () => {
    const getUserDirectory = vi.fn().mockResolvedValue({ items: [] });
    const client = { getUserDirectory } as unknown as InpulseApiClient;
    renderModal(client);

    const dialog = await screen.findByRole("dialog", { name: "新建项目" });
    expect(await within(dialog).findByText(/共 1 人/)).toBeInTheDocument();
    // 标签数按可用宽度自适应（maxTagCount=responsive），jsdom 没有布局宽度，
    // 这里改断言「创建者选项是 disabled」——rc-select 正是据此不给它渲染移除按钮。
    fireEvent.mouseDown(within(dialog).getByLabelText("选择项目成员"));
    const creatorOption = await screen.findByTitle("开发者 C");
    expect(creatorOption.className).toContain(
      "ant-select-item-option-disabled",
    );
  });

  it("documents the current module rule instead of the removed default module", async () => {
    const getUserDirectory = vi.fn().mockResolvedValue({ items: [] });
    const client = { getUserDirectory } as unknown as InpulseApiClient;
    renderModal(client);

    const dialog = await screen.findByRole("dialog", { name: "新建项目" });
    const rules = within(dialog).getByText("创建规则").closest("aside");
    expect(rules).not.toBeNull();
    const scope = within(rules as HTMLElement);
    expect(scope.getByText("模块")).toBeInTheDocument();
    expect(scope.queryByText(/未分类/u)).not.toBeInTheDocument();
  });

  it("derives the project code from the name until the code is edited manually", async () => {
    const getUserDirectory = vi.fn().mockResolvedValue({ items: [] });
    const client = { getUserDirectory } as unknown as InpulseApiClient;
    renderModal(client);

    const dialog = await screen.findByRole("dialog", { name: "新建项目" });
    const user = userEvent.setup();
    const nameInput = within(dialog).getByLabelText("项目名称");
    const codeInput = within(dialog).getByLabelText("项目编码");

    await user.type(nameInput, "商城系统 Shop2");
    expect(codeInput).toHaveValue("SHOP2");

    await user.clear(codeInput);
    await user.type(codeInput, "mall");
    await user.type(nameInput, " 二期");
    expect(codeInput).toHaveValue("MALL");

    await user.clear(codeInput);
    await user.type(nameInput, " 三期");
    expect(codeInput).toHaveValue("SHOP2");
  });
});
