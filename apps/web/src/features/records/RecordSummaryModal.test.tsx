import React from "react";
import { ConfigProvider } from "antd";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  CurrentUserResponse,
  InpulseApiClient,
  ReadableRecord,
  RecordSummaryAssistRequest,
  RecordSummaryResponse,
} from "@generated/api";
import { ApiError } from "@generated/api";
import { AuthStateProvider } from "@features/auth/auth-context";
import { RecordSummaryModal } from "./RecordSummaryModal";

/**
 * F-33 总结弹窗明细的可展开行：整个横向区域可点，展开区复用正式记录详情的只读
 * 形态——补的是记录正文（改动原因 / 具体改动 / 改动效果）与遗留问题，而要点里的
 * 效果句是被服务端折叠并截断到 1000 字的摘要。
 *
 * 只读断言是这批的核心：总结是核对取数用的只读视图，展开不得带出不可变版本、
 * GitHub 关联与修订 / 作废入口，否则会把写动作搬进总结弹窗。
 */

const admin: CurrentUserResponse = {
  id: 1,
  loginName: "dev-a",
  name: "管理员",
  email: null,
  avatarUrl: null,
  isAdmin: true,
  status: "ACTIVE",
};

/** 要点句与正文四段刻意用不同文本，避免断言撞到明细行里已经渲染的事实。 */
const record: ReadableRecord = {
  id: 7,
  projectId: 1,
  moduleId: 2,
  taskId: null,
  handlerId: 1,
  authorId: 1,
  status: "PUBLISHED",
  code: "SHOP-CR-1",
  currentVersion: 1,
  publishedAt: "2026-09-21T02:00:00.000Z",
  rowVersion: 2,
  createdAt: "2026-09-21T02:00:00.000Z",
  updatedAt: "2026-09-21T02:00:00.000Z",
  title: "支付修正",
  contextProblem: "改动原因正文",
  changeSolution: "具体改动正文",
  resultVerification: "改动效果正文",
  remainingIssues: [],
  leftovers: [
    {
      id: 31,
      content: "遗留问题正文",
      status: "ACTIVE",
      rowVersion: 1,
      linkedTaskId: null,
    },
  ],
};

const summary: RecordSummaryResponse = {
  generatedAt: "2026-09-29T02:00:00.000Z",
  range: { from: "2026-01-01", to: "2026-12-31" },
  groupBy: "PROJECT",
  scope: { projectIds: [1], projectNames: ["支付项目"], member: null },
  totals: {
    projectCount: 1,
    moduleCount: 1,
    recordCount: 1,
    completedTaskCount: 0,
    missingRecordTaskCount: 0,
    leftoverCount: 1,
    closedLeftoverCount: 0,
  },
  sections: [
    {
      key: "1",
      projectId: 1,
      member: null,
      recordCount: 1,
      completedTaskCount: 0,
    },
  ],
  points: [
    {
      recordId: 7,
      recordCode: "SHOP-CR-1",
      projectId: 1,
      projectName: "支付项目",
      moduleId: 2,
      moduleName: "支付模块",
      title: "支付修正",
      detail: "要点句",
      author: { userId: 1, name: "管理员", avatarUrl: null },
      publishedAt: "2026-09-21T02:00:00.000Z",
      taskId: null,
      taskCode: null,
    },
  ],
  leftovers: [],
  gaps: [],
  truncated: false,
};

/**
 * 只读展开没有列表语境，名称由正式记录详情自己解析（与聚合组记录弹窗同一路径），
 * 因此这里要把项目详情、模块清单与用户目录一并桩掉。
 */
/** ADR-076：AI 改写返回的是「整段 Markdown」，弹窗再切成可逐段编辑的段落。 */
const ASSIST_MARKDOWN = [
  "2026 年度总结",
  "",
  "## 一、整体概览",
  "本期范围内共 1 个项目、1 条迭代记录。",
  "",
  "- **支付修正**：要点句",
].join("\n");

function baseClient() {
  return {
    getRecordSummary: vi.fn().mockResolvedValue(summary),
    assistRecordSummary: vi.fn().mockResolvedValue({
      markdown: ASSIST_MARKDOWN,
      model: "test-model",
      truncated: false,
    }),
    getChangeRecord: vi.fn().mockResolvedValue(record),
    listChangeRecordVersions: vi.fn().mockResolvedValue({ items: [] }),
    getProject: vi.fn().mockResolvedValue({
      project: { id: 1, name: "支付项目", status: "ACTIVE" },
    }),
    listModules: vi.fn().mockResolvedValue({
      items: [{ id: 2, projectId: 1, name: "支付模块" }],
    }),
    getUserDirectory: vi.fn().mockResolvedValue({
      items: [{ id: 1, name: "管理员", avatarUrl: null, isAdmin: true }],
    }),
  };
}

function mount(client: InpulseApiClient) {
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <AuthStateProvider value={{ status: "authenticated", user: admin }}>
        <MemoryRouter initialEntries={["/records"]}>
          <QueryClientProvider
            client={
              new QueryClient({ defaultOptions: { queries: { retry: false } } })
            }
          >
            <RecordSummaryModal
              open
              onClose={() => undefined}
              client={client}
              defaultProjectId={0}
              projects={[]}
            />
          </QueryClientProvider>
        </MemoryRouter>
      </AuthStateProvider>
    </ConfigProvider>,
  );
}

const signalInit = expect.objectContaining({ signal: expect.any(AbortSignal) });

/** 取数完成前底栏按钮是禁用的（disabled={data === undefined}），先等它可用再点。 */
async function openDetail() {
  const toggle = await screen.findByRole("button", { name: "查看明细" });
  await waitFor(() => expect(toggle).toBeEnabled());
  fireEvent.click(toggle);
  // 进入明细后底栏按钮改成「返回总结」，以此确认模式已切换。
  await screen.findByRole("button", { name: "返回总结" });
  // 弹层刚打开时 rc-dialog 会短暂隐藏外层；用 waitFor 等它稳定，避免断言撞上过渡帧。
  await waitFor(() =>
    expect(screen.getByText("要点句", { selector: "small" })).toBeVisible(),
  );
}

/** jsdom 不提供 Clipboard API；复制行为由弹窗底栏按钮触发，这里只捕获写入内容。 */
function mockClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

describe("RecordSummaryModal 复制", () => {
  it("明细模式复制与明细表同列的 Markdown，而不是同一份总结正文", async () => {
    const writeText = mockClipboard();
    const client = baseClient();
    mount(client as unknown as InpulseApiClient);
    await openDetail();

    fireEvent.click(screen.getByRole("button", { name: "复制明细 Markdown" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = String(writeText.mock.calls[0]?.[0] ?? "");
    expect(copied).toContain(
      "| 编号 | 项目 / 模块 | 标题与效果 | 作者 | 发布日期 |",
    );
    expect(copied).toContain(
      "| SHOP-CR-1 | 支付项目 / 支付模块 | **支付修正**：要点句 | 管理员 | 2026-09-21 |",
    );
    expect(copied).not.toContain("## 整体概览");
  });

  it("正文模式仍复制总结正文", async () => {
    const writeText = mockClipboard();
    const client = baseClient();
    mount(client as unknown as InpulseApiClient);

    const copyButton = await screen.findByRole("button", { name: "复制正文" });
    await waitFor(() => expect(copyButton).toBeEnabled());
    fireEvent.click(copyButton);

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = String(writeText.mock.calls[0]?.[0] ?? "");
    expect(copied).toContain("2026 年度总结");
    expect(copied).toContain("## 整体概览");
    expect(copied).not.toContain("| 编号 |");
  });
});

describe("RecordSummaryModal 明细展开", () => {
  it("点行内任意位置就地展开记录正文与遗留问题，且不出现任何写入入口", async () => {
    const client = baseClient();
    mount(client as unknown as InpulseApiClient);
    await openDetail();
    // 默认收起：正文与遗留问题都不在页面上，也没有为任何一条记录发详情请求。
    expect(screen.queryByText("改动原因正文")).not.toBeInTheDocument();
    expect(screen.queryByText("遗留问题正文")).not.toBeInTheDocument();
    expect(client.getChangeRecord).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("要点句", { selector: "small" }), {
      bubbles: true,
    });

    expect(await screen.findByText("改动原因正文")).toBeVisible();
    expect(screen.getByText("具体改动正文")).toBeVisible();
    expect(screen.getByText("改动效果正文")).toBeVisible();
    expect(screen.getByText("遗留问题正文")).toBeVisible();
    expect(screen.getByText("未处理")).toBeVisible();
    expect(client.getChangeRecord).toHaveBeenCalledWith(1, 7, signalInit);
    // 只读形态：不可变版本、GitHub 关联、修订与作废入口都不渲染、不发请求。
    expect(client.listChangeRecordVersions).not.toHaveBeenCalled();
    expect(screen.queryByText("GitHub 关联")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "修订内容" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "作废记录" }),
    ).not.toBeInTheDocument();
  });

  it("首列箭头同步展开态，再点一次收起并卸载展开区", async () => {
    const client = baseClient();
    mount(client as unknown as InpulseApiClient);
    await openDetail();
    const arrow = screen.getByRole("button", {
      name: "展开 SHOP-CR-1 的详细内容",
    });
    expect(arrow).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(arrow);
    expect(
      await screen.findByRole("button", { name: "收起 SHOP-CR-1 的详细内容" }),
    ).toHaveAttribute("aria-expanded", "true");
    // 展开态立刻生效，正文要等详情请求回来。
    expect(await screen.findByText("改动原因正文")).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: "收起 SHOP-CR-1 的详细内容" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("改动原因正文")).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "展开 SHOP-CR-1 的详细内容" }),
    ).toHaveAttribute("aria-expanded", "false");
  });
});

/**
 * ADR-076 迭代总结 AI 助手：入口钉在标题栏右上角、浮层只要一句话要求（不做对话）、
 * 生成后的正文可逐段编辑。四条口径是这批断言的核心——发给服务端的 facts 必须就是
 * 弹窗当前的事实正文（服务端不再查库）、生成后正文进可编辑态、改动可单句回退与
 * 全量撤销、复制正文复制的是编辑后的文本。
 */
describe("RecordSummaryModal AI 助手", () => {
  // 标签记忆走 localStorage：用例之间必须清干净，否则默认标签断言会被上一条污染。
  beforeEach(() => {
    window.localStorage.clear();
  });
  /** 事实正文就绪后「生成总结」才可用；弹窗正文经 rc-dialog 传送到 body。 */
  async function openAssist(): Promise<HTMLElement> {
    fireEvent.click(await screen.findByRole("button", { name: "AI 助手" }));
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "AI 助手" })).toBeVisible(),
    );
    const generate = screen.getByRole("button", { name: "生成总结" });
    await waitFor(() => expect(generate).toBeEnabled());
    return generate;
  }

  function assistEdits(): readonly HTMLElement[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>(
        '.summary-ai-doc[data-source="assist"] .summary-ai-edit',
      ),
    );
  }

  it("入口在标题栏，点开是要一句话要求的浮层，不是聊天窗口", async () => {
    const client = baseClient();
    mount(client as unknown as InpulseApiClient);
    expect(client.assistRecordSummary).not.toHaveBeenCalled();
    // 默认不渲染浮层：AI 助手不占正文宽度、不占底栏。
    expect(
      screen.queryByRole("dialog", { name: "AI 助手" }),
    ).not.toBeInTheDocument();

    await openAssist();

    expect(screen.getByLabelText("对总结的要求")).toBeVisible();
    // 快捷要求是可点的短语，不是消息气泡；不打字也能起步。
    expect(screen.getByRole("button", { name: "突出遗留风险" })).toBeVisible();
  });

  it("生成时把当前范围的事实正文连同那一句要求交给 assistRecordSummary", async () => {
    const client = baseClient();
    mount(client as unknown as InpulseApiClient);
    const generate = await openAssist();
    fireEvent.change(screen.getByLabelText("对总结的要求"), {
      target: { value: "给领导看，先给结论" },
    });
    fireEvent.click(generate);

    await waitFor(() =>
      expect(client.assistRecordSummary).toHaveBeenCalledTimes(1),
    );
    const body = client.assistRecordSummary.mock.calls[0]?.[0] as
      RecordSummaryAssistRequest | undefined;
    expect(body?.requirement).toBe("给领导看，先给结论");
    // facts 就是弹窗的事实正文本身：服务端据此改写，不再查库、不新增读权限。
    expect(body?.facts).toContain("## 整体概览");
    expect(body?.facts).toContain("- **支付修正**：要点句");

    // 生成后浮层收起，正文进入可编辑态（标题 / 小节 / 段落 / 列表项共四段）。
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "AI 助手" }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(assistEdits()).toHaveLength(4));
  });

  it("生成的正文可逐段编辑：改过的段画橙点，可单句回退也可全量撤销", async () => {
    const client = baseClient();
    mount(client as unknown as InpulseApiClient);
    fireEvent.click(await openAssist());
    await waitFor(() => expect(assistEdits()).toHaveLength(4));

    const [firstNode, secondNode] = assistEdits();
    if (firstNode === undefined || secondNode === undefined) {
      throw new Error("缺少可编辑段");
    }
    firstNode.textContent = "改过的第一句";
    fireEvent.input(firstNode);
    secondNode.textContent = "改过的第二句";
    fireEvent.input(secondNode);

    // 状态行不再复述「改了几处」（橙点已标出改过的段），有改动时只多出一个撤销入口。
    expect(screen.getByRole("button", { name: "撤销手动修改" })).toBeVisible();
    expect(firstNode.closest(".summary-ai-sec")).toHaveAttribute(
      "data-edited",
      "true",
    );
    expect(secondNode.closest(".summary-ai-sec")).toHaveAttribute(
      "data-edited",
      "true",
    );

    // 单句回退：只把这一句恢复成模型原文，另一处改动保留。
    const [firstRevert] = screen.getAllByRole("button", {
      name: /^回退/,
      hidden: true,
    });
    if (firstRevert === undefined) throw new Error("缺少回退按钮");
    fireEvent.click(firstRevert);
    await waitFor(() =>
      expect(firstNode.closest(".summary-ai-sec")).toHaveAttribute(
        "data-edited",
        "false",
      ),
    );
    // 第二处改动还在：橙点与撤销入口都不消失。
    expect(secondNode.closest(".summary-ai-sec")).toHaveAttribute(
      "data-edited",
      "true",
    );
    expect(screen.getByRole("button", { name: "撤销手动修改" })).toBeVisible();
    expect(firstNode.textContent).toBe("2026 年度总结");
    expect(secondNode.textContent).toBe("改过的第二句");

    // 再改一处后全量撤销：两处都回到模型刚生成时的原文。
    firstNode.textContent = "又改了一次";
    fireEvent.input(firstNode);
    fireEvent.click(screen.getByRole("button", { name: "撤销手动修改" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "撤销手动修改" })).toBeNull(),
    );
    expect(firstNode.textContent).toBe("2026 年度总结");
    expect(secondNode.textContent).toBe("一、整体概览");
  });

  it("生成后「复制正文」复制的是编辑后的文本，与编辑视图同一份口径", async () => {
    const writeText = mockClipboard();
    const client = baseClient();
    mount(client as unknown as InpulseApiClient);
    fireEvent.click(await openAssist());
    await waitFor(() => expect(assistEdits()).toHaveLength(4));

    const bullet = assistEdits()[3];
    if (bullet === undefined) throw new Error("缺少列表段");
    bullet.textContent = "**支付修正**：改成一句话总结";
    fireEvent.input(bullet);

    fireEvent.click(screen.getByRole("button", { name: "复制正文" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = String(writeText.mock.calls[0]?.[0] ?? "");
    expect(copied).toContain("## 一、整体概览");
    expect(copied).toContain("- **支付修正**：改成一句话总结");
    expect(copied).not.toContain("要点句");
  });

  it("AI 未启用时在浮层内给出固定提示，且不改动正文", async () => {
    const client = baseClient();
    client.assistRecordSummary.mockRejectedValueOnce(
      new ApiError(503, {
        code: "AI_ASSIST_DISABLED",
        details: {},
        requestId: "req-1",
      }),
    );
    mount(client as unknown as InpulseApiClient);
    fireEvent.click(await openAssist());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("AI 辅助转换未启用");
    // 失败不切正文：仍是本地确定性正文，浮层留在原地等用户改要求重试。
    expect(assistEdits()).toHaveLength(0);
    expect(screen.getByRole("dialog", { name: "AI 助手" })).toBeVisible();
  });

  it("标签可切换：点一下拼进要求、再点一下移除，输入框带计数与清空", async () => {
    const client = baseClient();
    mount(client as unknown as InpulseApiClient);
    await openAssist();

    const chip = screen.getByRole("button", { name: "突出遗留风险" });
    fireEvent.click(chip);
    expect(screen.getByLabelText("对总结的要求")).toHaveValue("突出遗留风险");
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("6/500")).toBeVisible();

    fireEvent.click(chip);
    expect(screen.getByLabelText("对总结的要求")).toHaveValue("");
    expect(
      screen.queryByRole("button", { name: "清空要求" }),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("对总结的要求"), {
      target: { value: "给领导看，先给结论" },
    });
    expect(screen.getByRole("button", { name: "清空要求" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "清空要求" }));
    expect(screen.getByLabelText("对总结的要求")).toHaveValue("");
  });

  it("生成成功后标签换成上次要求的片段，并记住到本地浏览器", async () => {
    const client = baseClient();
    mount(client as unknown as InpulseApiClient);
    const generate = await openAssist();
    fireEvent.change(screen.getByLabelText("对总结的要求"), {
      target: { value: "周报口吻，三百字内" },
    });
    fireEvent.click(generate);
    await waitFor(() =>
      expect(client.assistRecordSummary).toHaveBeenCalledTimes(1),
    );

    fireEvent.click(await screen.findByRole("button", { name: "AI 助手" }));
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "AI 助手" })).toBeVisible(),
    );
    expect(screen.getByRole("button", { name: "周报口吻" })).toBeVisible();
    expect(screen.getByRole("button", { name: "三百字内" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "突出遗留风险" }),
    ).not.toBeInTheDocument();
    expect(
      window.localStorage.getItem("inpulse.ai-assist.last-requirement"),
    ).toBe("周报口吻，三百字内");
  });

  it("Esc 只收浮层，总结弹窗保持打开", async () => {
    const client = baseClient();
    mount(client as unknown as InpulseApiClient);
    await openAssist();

    fireEvent.keyDown(screen.getByLabelText("对总结的要求"), {
      key: "Escape",
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "AI 助手" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "查看明细" })).toBeVisible();
  });
});

/**
 * 本地确定性正文与 AI 正文共用同一套就地编辑：改句即计数、复制取改动版、
 * 单句回退与全量撤销复用同一张 edited 表；scopeLine 是事实元数据，不可编辑。
 */
describe("RecordSummaryModal 本地正文就地编辑", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("改一句即出现撤销入口，复制取改动版，单句回退与全量撤销都生效", async () => {
    const writeText = mockClipboard();
    const client = baseClient();
    mount(client as unknown as InpulseApiClient);

    const node = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        '[data-key="local:0:text"]',
      );
      if (found === null) throw new Error("概览可编辑段未渲染");
      return found;
    });
    const original = node.textContent ?? "";
    expect(node).toHaveAttribute("contenteditable", "true");

    node.textContent = "改过的概览句";
    fireEvent.input(node);
    // 弹窗入场动画走完后再断言可见性（与 AI 用例的等待口径一致）。
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "撤销手动修改" }),
      ).toBeVisible(),
    );

    fireEvent.click(screen.getByRole("button", { name: "复制正文" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(String(writeText.mock.calls[0]?.[0] ?? "")).toContain(
      "改过的概览句",
    );

    const revertButton = node
      .closest(".summary-ai-sec")
      ?.querySelector("button.summary-ai-revert");
    if (!(revertButton instanceof HTMLElement)) throw new Error("缺少回退按钮");
    fireEvent.click(revertButton);
    expect(node.textContent).toBe(original);
    expect(screen.queryByRole("button", { name: "撤销手动修改" })).toBeNull();

    node.textContent = "又改了一次";
    fireEvent.input(node);
    fireEvent.click(screen.getByRole("button", { name: "撤销手动修改" }));
    expect(node.textContent).toBe(original);
    expect(screen.queryByRole("button", { name: "撤销手动修改" })).toBeNull();
  });

  it("scopeLine 是事实元数据，不参与就地编辑", async () => {
    const client = baseClient();
    mount(client as unknown as InpulseApiClient);
    const scope = await screen.findByText(
      /\d{4}-\d{2}-\d{2} - \d{4}-\d{2}-\d{2}/,
    );
    expect(scope).not.toHaveAttribute("contenteditable");
  });
  /** 底栏**直接子级**按钮的 DOM 顺序：用户要求「复制正文」永远在最右侧。 */
  function footerButtons(): readonly HTMLElement[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>(".calm-action-footer > button"),
    );
  }

  it("底栏固定三枚按钮、「复制正文」永远最右；撤销降级成状态行里的浅链接", async () => {
    const client = baseClient();
    mount(client as unknown as InpulseApiClient);
    // 未编辑：底栏就是三枚按钮，没有「撤销手动修改」。
    expect(
      footerButtons().map((button) => button.textContent?.trim() ?? ""),
    ).toEqual(["查看明细", "重新生成", "复制正文"]);
    expect(screen.queryByRole("button", { name: "撤销手动修改" })).toBeNull();

    const node = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        '[data-key="local:0:text"]',
      );
      if (found === null) throw new Error("概览可编辑段未渲染");
      return found;
    });
    node.textContent = "改过的概览句";
    fireEvent.input(node);

    const revert = await screen.findByRole("button", { name: "撤销手动修改" });
    // 降级为状态行末尾的浅链接：不占底栏按钮位、也不再用警示色。
    expect(revert.closest(".summary-footer-count")).not.toBeNull();
    expect(revert.className).toMatch(/ant-btn-(link|variant-link)/);
    expect(revert.className).not.toContain("ant-btn-dangerous");
    expect(
      footerButtons().map((button) => button.textContent?.trim() ?? ""),
    ).toEqual(["查看明细", "重新生成", "复制正文"]);
    expect(footerButtons().at(-1)).toHaveTextContent("复制正文");
  });
});
