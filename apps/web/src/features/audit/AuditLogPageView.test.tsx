import React from "react";
import { ConfigProvider } from "antd";
import {
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
  type AuditLogItem,
  type AuditLogPage,
  type InpulseApiClient,
} from "@generated/api";
import { AuthStateProvider } from "@features/auth/auth-context";
import { AuditLogPageView } from "./AuditLogPageView";

const systemItem: AuditLogItem = {
  chainId: "SYSTEM",
  sequenceNo: 12,
  projectId: null,
  actorType: "USER",
  actorId: 1,
  action: "admin.user.create",
  targetType: "USER",
  targetId: "2",
  eventPayload: { loginName: "bob", reason: "阶段联调" },
  requestId: "request-1",
  clientRequestId: "client-9",
  ipAddress: "10.0.0.8",
  userAgent: "vitest-agent",
  occurredAt: "2026-09-11T08:00:00.000Z",
  prevHash: "a".repeat(64),
  recordHash: "b".repeat(64),
  keyVersion: 1,
  canonicalVersion: "JCS-1",
};

const projectItem: AuditLogItem = {
  ...systemItem,
  chainId: "PROJECT:7",
  sequenceNo: 3,
  projectId: 7,
  action: "project.update",
  targetType: "PROJECT",
  targetId: "7",
};

const historicalReadTrailItem: AuditLogItem = {
  ...systemItem,
  sequenceNo: 13,
  action: "AUDIT_LOG_READ",
  targetType: "AUDIT_CHAIN",
  targetId: "SYSTEM",
  eventPayload: { returnedCount: 50, hasMore: true },
};

const taskItem: AuditLogItem = {
  ...systemItem,
  chainId: "PROJECT:7",
  sequenceNo: 14,
  projectId: 7,
  action: "task.status",
  targetType: "TASK",
  targetId: "9370",
  eventPayload: { after: { code: "INPULSE-T-59", title: "登录测试" } },
};

// 演示种子数据是平铺载荷，没有 after/before 包裹。
const seedFeatureItem: AuditLogItem = {
  ...systemItem,
  chainId: "PROJECT:7",
  sequenceNo: 15,
  projectId: 7,
  action: "feature.create",
  targetType: "FEATURE",
  targetId: "20",
  eventPayload: { code: "INPULSE-F-11", name: "工程基建" },
};

// ADR-062：保留期自动清理已下线，该动作只剩历史行，用于校验中文标签表仍然生效。
const purgeItem: AuditLogItem = {
  ...systemItem,
  sequenceNo: 16,
  action: "project.purge",
  targetType: "PROJECT",
  targetId: "41",
  eventPayload: { code: "T1", name: "旧版交付平台" },
};

// 管理配置类动作（机器人 / AI / 文档导入）：2026-10-13 补中文标签，
// 目标类型此前也未收录，行内会回退成原始机器码。
const wecomRobotItem: AuditLogItem = {
  ...systemItem,
  sequenceNo: 17,
  action: "admin.wecomRobot.update",
  targetType: "WECOM_ROBOT_CONFIG",
  targetId: "1",
  eventPayload: {
    before: { configured: false },
    after: { botId: "aib-demo-bot", rowVersion: 1, botProfileUrl: null },
    secretChanged: true,
  },
};

const aiAssistItem: AuditLogItem = {
  ...systemItem,
  sequenceNo: 18,
  action: "admin.aiAssistSettings.update",
  targetType: "AI_ASSIST_SETTINGS",
  targetId: "1",
  eventPayload: {
    before: { configured: false },
    after: { enabled: true, model: "gpt-demo", rowVersion: 1 },
    keyChanged: true,
  },
};

const documentImportItem: AuditLogItem = {
  ...systemItem,
  chainId: "PROJECT:7",
  sequenceNo: 19,
  projectId: 7,
  action: "project.documentImport",
  targetType: "PROJECT",
  targetId: "7",
  eventPayload: { digest: "d".repeat(16), addedMemberCount: 3 },
};

// ADR-082：删除不可逆，但审计列表仍展示删除前的姓名；原始快照保留删除后的墓碑载荷。
const deleteUserItem: AuditLogItem = {
  ...systemItem,
  sequenceNo: 20,
  action: "admin.user.delete",
  targetType: "USER",
  targetId: "9",
  eventPayload: {
    before: { id: 9, loginName: "xiaowu", name: "小吴" },
    after: { id: 9, loginName: "deleted-user-9", name: "删除用户" },
  },
};

// ADR-062：项目已物理删除，列表只能从审计载荷还原删除前的编码和名称。
const deletedProjectItem: AuditLogItem = {
  ...systemItem,
  sequenceNo: 21,
  action: "project.delete",
  targetType: "PROJECT",
  targetId: "41",
  eventPayload: {
    code: "E2EDEL523528EA0480",
    name: "交付平台",
    status: "ACTIVE",
    rowVersion: 3,
  },
};

const project = {
  id: 7,
  code: "AGV",
  name: "AGV 智能搬运平台",
  description: "",
  status: "ACTIVE" as const,
  rowVersion: 1,
  createdBy: 1,
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
  memberCount: 4,
  stats: {
    activeModuleCount: 2,
    activeFeatureCount: 5,
    openTaskCount: 3,
    completedTaskCount: 1,
  },
};

function queryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

/**
 * 渲染前统一补用户目录 mock（断言里就能看到人名而不是「用户 #N」），
 * 用例自带同名 mock 时以后者为准。
 */
function withUserDirectory(client: InpulseApiClient): InpulseApiClient {
  const defaults = {
    getUserDirectory: vi.fn().mockResolvedValue({
      items: [
        { id: 1, name: "邵昱宇", avatarUrl: null, isAdmin: true },
        { id: 2, name: "Bob", avatarUrl: null, isAdmin: false },
      ],
    }),
  };
  return { ...defaults, ...client } as unknown as InpulseApiClient;
}

function mount(client: InpulseApiClient) {
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <AuthStateProvider value={{}}>
        <QueryClientProvider client={queryClient()}>
          <AuditLogPageView client={withUserDirectory(client)} />
        </QueryClientProvider>
      </AuthStateProvider>
    </ConfigProvider>,
  );
}

function page(items: readonly AuditLogItem[]): AuditLogPage {
  return { items: [...items], nextCursor: null, hasMore: false };
}

/** CalmSelect 交互：打开下拉并点选目标项（弹层项带 title 属性）。 */
function pickSelectOption(label: string, optionTitle: string) {
  const field = screen.getByLabelText(label);
  const trigger = field.closest(".ant-select");
  if (!trigger) {
    throw new Error("select trigger not found for " + label);
  }
  fireEvent.mouseDown(trigger);
  fireEvent.click(screen.getByTitle(optionTitle));
}

describe("F-08 audit page", () => {
  it("默认读取「全部记录（所有链）」并渲染原始审计行（ADR-061）", async () => {
    const getAuditLogs = vi.fn().mockResolvedValue(page([systemItem]));
    const listProjects = vi.fn().mockResolvedValue({ items: [project] });
    mount({ getAuditLogs, listProjects } as unknown as InpulseApiClient);

    expect(await screen.findByText("创建用户")).toBeInTheDocument();
    expect(getAuditLogs.mock.calls[0]?.[0]).toEqual({
      chain: "all",
      limit: 50,
    });
    expect(screen.getByText("当前链：全部记录（所有链）")).toBeInTheDocument();
    expect(screen.getByText("邵昱宇")).toBeInTheDocument();
    expect(screen.getByText("对象：用户 Bob")).toBeInTheDocument();
    expect(screen.getByText("第 12 条 · 系统链")).toBeInTheDocument();
    expect(screen.queryByText("加载更多")).not.toBeInTheDocument();
  });

  it("可切回单链读取：SYSTEM 链不再携带 chain 参数", async () => {
    const getAuditLogs = vi.fn().mockResolvedValue(page([systemItem]));
    const listProjects = vi.fn().mockResolvedValue({ items: [project] });
    mount({ getAuditLogs, listProjects } as unknown as InpulseApiClient);

    await screen.findByText("创建用户");
    pickSelectOption("审计链", "SYSTEM 链（系统级）");

    // 缺省语义与改动前一致：不传 projectId / chain 即读 SYSTEM 链。
    await waitFor(() =>
      expect(getAuditLogs).toHaveBeenLastCalledWith(
        { limit: 50 },
        expect.anything(),
      ),
    );
    expect(screen.getByText("当前链：SYSTEM 链")).toBeInTheDocument();
  });

  it("动作候选不再列出已下线动作码，历史行仍按中文文案渲染（ADR-061）", async () => {
    const getAuditLogs = vi.fn().mockResolvedValue(page([systemItem]));
    const listProjects = vi.fn().mockResolvedValue({ items: [project] });
    mount({ getAuditLogs, listProjects } as unknown as InpulseApiClient);

    await screen.findByText("创建用户");
    const codes = Array.from(
      document.querySelectorAll<HTMLOptionElement>(
        "#audit-action-options option",
      ),
    ).map((option) => option.value);
    // 已下线动作码 + 仅测试写入的 SYSTEM_TEST 都不再是筛选候选。
    for (const retired of [
      "project.archive",
      "project.archive.request",
      "project.archive.reject",
      "project.restore",
      "project.purge",
      "module.archive",
      "module.restore",
      "feature.archive",
      "feature.restore",
      "task.archive",
      "task.unarchive",
      "AUDIT_LOG_READ",
      "SYSTEM_TEST",
    ]) {
      expect(codes).not.toContain(retired);
    }
    // 仍在产生记录的动作码必须保留。
    expect(codes).toContain("project.create");
    expect(codes).toContain("task.create");
    expect(codes).toContain("project.delete");
  });

  it("管理配置动作显示中文标签与目标类型（机器人 / AI / 文档导入）", async () => {
    const getAuditLogs = vi
      .fn()
      .mockResolvedValue(
        page([wecomRobotItem, aiAssistItem, documentImportItem]),
      );
    const listProjects = vi.fn().mockResolvedValue({ items: [project] });
    mount({ getAuditLogs, listProjects } as unknown as InpulseApiClient);

    expect(await screen.findByText("更新机器人配置")).toBeInTheDocument();
    expect(screen.getByText("更新 AI 辅助设置")).toBeInTheDocument();
    expect(screen.getByText("导入文档")).toBeInTheDocument();
    expect(screen.getByText("对象：企业微信机器人配置 #1")).toBeInTheDocument();
    expect(screen.getByText("对象：AI 辅助设置 #1")).toBeInTheDocument();
    expect(screen.getByText("对象：项目 AGV 智能搬运平台")).toBeInTheDocument();

    // 三个动作码同时进入筛选候选（option 以原始码为 value）。
    const codes = Array.from(
      document.querySelectorAll<HTMLOptionElement>(
        "#audit-action-options option",
      ),
    ).map((option) => option.value);
    expect(codes).toContain("admin.wecomRobot.update");
    expect(codes).toContain("admin.aiAssistSettings.update");
    expect(codes).toContain("project.documentImport");
  });

  it("删除用户动作显示中文，并保留审计载荷中的删除前姓名", async () => {
    const user = userEvent.setup();
    const getAuditLogs = vi.fn().mockResolvedValue(page([deleteUserItem]));
    const listProjects = vi.fn().mockResolvedValue({ items: [project] });
    mount({ getAuditLogs, listProjects } as unknown as InpulseApiClient);

    const row = await screen.findByTestId("audit-item-SYSTEM-20");
    expect(within(row).getByText("强制删除用户")).toBeInTheDocument();
    expect(within(row).getByText("对象：用户 小吴")).toBeInTheDocument();
    expect(
      within(row).queryByText("admin.user.delete"),
    ).not.toBeInTheDocument();
    expect(
      within(row).queryByText("对象：用户 删除用户"),
    ).not.toBeInTheDocument();

    await user.click(
      within(row).getByRole("button", { name: "查看原始快照 第 20 条" }),
    );
    const payload = screen.getByTestId("audit-snapshot-payload");
    expect(payload.textContent ?? "").toContain('"name": "小吴"');
    expect(payload.textContent ?? "").toContain('"name": "删除用户"');
  });

  it("已删除项目仍显示审计载荷中的项目编码和名称，不回退为项目 null", async () => {
    const getAuditLogs = vi.fn().mockResolvedValue(page([deletedProjectItem]));
    const listProjects = vi.fn().mockResolvedValue({ items: [project] });
    mount({ getAuditLogs, listProjects } as unknown as InpulseApiClient);

    const row = await screen.findByTestId("audit-item-SYSTEM-21");
    expect(within(row).getByText("删除项目")).toBeInTheDocument();
    expect(
      within(row).getByText("对象：项目 E2EDEL523528EA0480「交付平台」"),
    ).toBeInTheDocument();
    expect(within(row).queryByText("对象：项目 null")).not.toBeInTheDocument();
  });

  it("labels entity targets with the code and name carried by the payload", async () => {
    const getAuditLogs = vi
      .fn()
      .mockResolvedValue(page([taskItem, seedFeatureItem]));
    const listProjects = vi.fn().mockResolvedValue({ items: [project] });
    mount({ getAuditLogs, listProjects } as unknown as InpulseApiClient);

    const taskLabel = "对象：任务 INPULSE-T-59「登录测试」";
    const featureLabel = "对象：功能 INPULSE-F-11「工程基建」";
    expect(await screen.findByText(taskLabel)).toBeInTheDocument();
    expect(screen.getByText(featureLabel)).toBeInTheDocument();
  });

  it("把 project.purge 历史行显示为中文动作，不泄露原始码", async () => {
    const getAuditLogs = vi.fn().mockResolvedValue(page([purgeItem]));
    const listProjects = vi.fn().mockResolvedValue({ items: [project] });
    mount({ getAuditLogs, listProjects } as unknown as InpulseApiClient);

    expect(await screen.findByText("彻底删除项目")).toBeInTheDocument();
    expect(screen.queryByText("project.purge")).not.toBeInTheDocument();
  });

  it("renders historical AUDIT_LOG_READ rows as ordinary rows（ADR-060）", async () => {
    const getAuditLogs = vi
      .fn()
      .mockResolvedValue(page([historicalReadTrailItem, systemItem]));
    const listProjects = vi.fn().mockResolvedValue({ items: [project] });
    mount({ getAuditLogs, listProjects } as unknown as InpulseApiClient);

    // 读取留痕已下线：历史行照常渲染，页面上不再有隐藏开关与隐藏计数。
    expect(await screen.findByText("读取审计日志")).toBeInTheDocument();
    expect(screen.getByText("创建用户")).toBeInTheDocument();
    expect(screen.queryByLabelText("隐藏读取留痕")).not.toBeInTheDocument();
    expect(screen.queryByText(/本页已隐藏/)).not.toBeInTheDocument();
    expect(screen.queryByText("显示读取留痕")).not.toBeInTheDocument();
    expect(getAuditLogs.mock.calls[0]?.[0]).toEqual({
      chain: "all",
      limit: 50,
    });
  });

  it("switches to a project chain and sends the project scope", async () => {
    const getAuditLogs = vi.fn().mockResolvedValue(page([projectItem]));
    const listProjects = vi.fn().mockResolvedValue({ items: [project] });
    mount({ getAuditLogs, listProjects } as unknown as InpulseApiClient);

    await screen.findByText("更新项目");
    pickSelectOption("审计链", "PROJECT:" + project.id + " · " + project.name);

    // 切换审计对象只影响查询参数，不再产生任何留痕语义（ADR-060）。
    await waitFor(() =>
      expect(getAuditLogs).toHaveBeenLastCalledWith(
        { projectId: 7, limit: 50 },
        expect.anything(),
      ),
    );
    expect(await screen.findByText("更新项目")).toBeInTheDocument();
    expect(
      screen.getByText("第 3 条 · 项目 AGV 智能搬运平台"),
    ).toBeInTheDocument();
  });

  it("only applies filters after the query button is pressed", async () => {
    const getAuditLogs = vi.fn().mockResolvedValue(page([systemItem]));
    const listProjects = vi.fn().mockResolvedValue({ items: [project] });
    mount({ getAuditLogs, listProjects } as unknown as InpulseApiClient);
    await screen.findByText("创建用户");
    expect(getAuditLogs).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("动作码"), {
      target: { value: "project.update" },
    });
    pickSelectOption("操作人", "邵昱宇");
    fireEvent.change(screen.getByLabelText("开始时间"), {
      target: { value: "2026-09-01T08:00" },
    });
    expect(getAuditLogs).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "查询" }));
    await waitFor(() =>
      expect(getAuditLogs).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: "project.update",
          actorIds: [1],
          // 表单里填的 08:00 是北京时间，落到 UTC 是前一天 00:00。
          from: "2026-09-01T00:00:00.000Z",
        }),
        expect.anything(),
      ),
    );
  });

  it("rejects an inverted time range before calling the server", async () => {
    const getAuditLogs = vi.fn().mockResolvedValue(page([systemItem]));
    const listProjects = vi.fn().mockResolvedValue({ items: [project] });
    mount({ getAuditLogs, listProjects } as unknown as InpulseApiClient);
    await screen.findByText("创建用户");

    fireEvent.change(screen.getByLabelText("开始时间"), {
      target: { value: "2026-09-02T08:00" },
    });
    fireEvent.change(screen.getByLabelText("结束时间"), {
      target: { value: "2026-09-01T08:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "查询" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "开始时间必须早于结束时间",
    );
    expect(getAuditLogs).toHaveBeenCalledTimes(1);
  });

  it("labels the time fields concisely and shortens the actor hint", async () => {
    const getAuditLogs = vi.fn().mockResolvedValue(page([systemItem]));
    const listProjects = vi.fn().mockResolvedValue({ items: [project] });
    mount({ getAuditLogs, listProjects } as unknown as InpulseApiClient);
    await screen.findByText("创建用户");

    // 2026-10-10 方案 B：可视标签简化为「开始 / 结束」，无障碍名保留完整语义，
    // 现有用例仍按 getByLabelText("开始时间") 定位。
    expect(screen.getByText("开始")).toBeInTheDocument();
    expect(screen.getByText("结束")).toBeInTheDocument();
    expect(screen.getByLabelText("开始时间")).toBeInTheDocument();
    expect(screen.getByLabelText("结束时间")).toBeInTheDocument();

    // 操作人占位文案改短为「全员（可勾选多人）」，页面上不再出现「可搜索多选」。
    expect(screen.getByText("全员（可勾选多人）")).toBeInTheDocument();
    expect(screen.queryByText(/可搜索多选/)).not.toBeInTheDocument();
  });

  it("opens the raw snapshot modal with payload, hashes and request metadata", async () => {
    const user = userEvent.setup();
    const getAuditLogs = vi.fn().mockResolvedValue(page([systemItem]));
    const listProjects = vi.fn().mockResolvedValue({ items: [project] });
    mount({ getAuditLogs, listProjects } as unknown as InpulseApiClient);

    await user.click(
      await screen.findByRole("button", { name: "查看原始快照 第 12 条" }),
    );
    expect(await screen.findByText("原始审计快照")).toBeInTheDocument();
    const payload = screen.getByTestId("audit-snapshot-payload");
    expect(payload.textContent ?? "").toMatch(/"loginName":\s*"bob"/);
    expect(screen.getByText("request-1")).toBeInTheDocument();
    expect(screen.getByText("client-9")).toBeInTheDocument();
    expect(screen.getByText("10.0.0.8")).toBeInTheDocument();
    expect(screen.getByText("vitest-agent")).toBeInTheDocument();
    expect(screen.getByText("b".repeat(64))).toBeInTheDocument();
    expect(
      screen.getByText("审计日志不允许删除；原始快照仅系统管理员可见。"),
    ).toBeInTheDocument();
  });

  it("copies the record hash and the raw payload from the snapshot modal", async () => {
    const user = userEvent.setup();
    // jsdom 不提供 Clipboard API：这里只捕获写入内容与按钮反馈。
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const getAuditLogs = vi.fn().mockResolvedValue(page([systemItem]));
    const listProjects = vi.fn().mockResolvedValue({ items: [project] });
    mount({ getAuditLogs, listProjects } as unknown as InpulseApiClient);

    await user.click(
      await screen.findByRole("button", { name: "查看原始快照 第 12 条" }),
    );
    await screen.findByText("原始审计快照");

    // 2026-10-10 起：请求 ID、客户端请求 ID、两条哈希与事件载荷各带一键复制。
    expect(screen.getAllByRole("button", { name: "复制" })).toHaveLength(5);

    const hashRow = screen.getByText("b".repeat(64)).closest("dd");
    expect(hashRow).not.toBeNull();
    await user.click(
      within(hashRow as HTMLElement).getByRole("button", { name: "复制" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toBe("b".repeat(64));
    expect(
      within(hashRow as HTMLElement).getByRole("button", { name: "已复制" }),
    ).toBeInTheDocument();

    const payloadBlock = screen
      .getByTestId("audit-snapshot-payload")
      .closest(".snapshot-payload") as HTMLElement;
    await user.click(
      within(payloadBlock).getByRole("button", { name: "复制" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(String(writeText.mock.calls[1]?.[0] ?? "")).toContain(
      '"loginName": "bob"',
    );
  });

  it("follows the signed cursor through load more", async () => {
    const user = userEvent.setup();
    const getAuditLogs = vi
      .fn()
      .mockResolvedValueOnce({
        items: [systemItem],
        nextCursor: "cursor-1",
        hasMore: true,
      } satisfies AuditLogPage)
      .mockResolvedValueOnce(page([projectItem]));
    const listProjects = vi.fn().mockResolvedValue({ items: [project] });
    mount({ getAuditLogs, listProjects } as unknown as InpulseApiClient);

    await user.click(await screen.findByRole("button", { name: "加载更多" }));
    await waitFor(() =>
      expect(getAuditLogs).toHaveBeenLastCalledWith(
        { chain: "all", cursor: "cursor-1", limit: 50 },
        expect.anything(),
      ),
    );
    expect(await screen.findByText("更新项目")).toBeInTheDocument();
    expect(screen.queryByText("加载更多")).not.toBeInTheDocument();
  });

  it("shows the administrator permission copy when the read is forbidden", async () => {
    const getAuditLogs = vi.fn().mockRejectedValue(
      new ApiError(403, {
        code: "ADMIN_REQUIRED",
        message: "internal-forbidden",
        details: {},
        requestId: "forbidden",
      }),
    );
    const listProjects = vi.fn().mockResolvedValue({ items: [] });
    mount({ getAuditLogs, listProjects } as unknown as InpulseApiClient);

    expect(await screen.findByText("原始审计读取失败")).toBeInTheDocument();
    expect(
      screen.getByText("原始审计仅系统管理员可读取。"),
    ).toBeInTheDocument();
    expect(screen.queryByText("internal-forbidden")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("maps read failures to safe copy with a retry entry", async () => {
    const getAuditLogs = vi.fn().mockRejectedValue(
      new ApiError(422, {
        code: "VALIDATION_FAILED",
        message: "internal-detail",
        details: {},
        requestId: "r",
      }),
    );
    const listProjects = vi.fn().mockResolvedValue({ items: [] });
    mount({ getAuditLogs, listProjects } as unknown as InpulseApiClient);

    expect(await screen.findByText("原始审计读取失败")).toBeInTheDocument();
    expect(screen.getByText(/游标已过期/)).toBeInTheDocument();
    expect(screen.queryByText("internal-detail")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});
