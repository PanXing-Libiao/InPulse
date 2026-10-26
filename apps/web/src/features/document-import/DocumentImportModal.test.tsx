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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  DOCUMENT_IMPORT_TEMPLATE,
  type CurrentUserResponse,
  type DocumentImportAssistResponse,
  type FeatureItem,
  type InpulseApiClient,
  type ModuleItem,
  type ProjectDocumentImportPreviewResponse,
  type ProjectDocumentImportResult,
  type ProjectListItem,
  type UserDirectoryItem,
} from "@generated/api";
import { AuthStateProvider } from "@features/auth/auth-context";
import { DocumentImportModal } from "./DocumentImportModal";
import type { DocumentImportMode } from "./document-import-query";
import {
  DocumentExtractionError,
  extractDocumentText,
  type ExtractedDocumentText,
} from "./document-text-extraction";

/**
 * ADR-064 文档导入弹窗：固定模板粘贴 → 只读预览 → 单事务执行。
 * ADR-067 追加 AI 辅助转换（本地抽取 → 生成草稿 → 直接落回左栏草稿）。
 * ADR-071 输入态改成左右分栏工作台：左栏结构化草稿（点哪改哪 + 内容梳理 /
 * 预览文档页签），右栏 AI 助手追问与待确认成员。
 */
vi.mock("./document-text-extraction", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./document-text-extraction")>();
  return { ...actual, extractDocumentText: vi.fn() };
});

const extractDocumentTextMock = vi.mocked(extractDocumentText);

const DOCUMENT = "# 项目：商城系统\n- 项目编码：SHOP";
const ASSIST_MARKDOWN = "# 项目：商城系统\n- 项目编码：MALL";

/** 必填（负责人）齐全、只剩「模块说明」这类建议项：用来验证建议清单不再每轮复读。 */
const SUGGEST_ONLY_DOCUMENT = [
  "# 项目：商城结算系统",
  "- 项目编码：MALL",
  "## 模块：购物车",
  "### 功能：数量调整",
  "- 当前说明：支持直接改数量",
  "- 验收标准：改完数量后金额即时刷新",
  "- 标签：前端",
  "#### 任务：数量调整交互",
  "- 负责人：林雨",
  "- 优先级：高",
  "- 截止：2026-10-20",
  "- 描述：数量调整与金额联动",
].join("\n");

/** 一份结构完整、但有两个负责人对不上账号的模板草稿。 */
const WORKBENCH_DOCUMENT = [
  "# 项目：商城结算系统",
  "- 项目编码：MALL",
  "- 项目成员：林雨、陈昊",
  "## 模块：购物车",
  "- 说明：购物车增删改与价格试算",
  "### 功能：数量调整",
  "- 当前说明：支持直接改数量",
  "#### 任务：数量调整交互",
  "- 负责人：林雨",
  "- 优先级：高",
  "#### 任务：数量调整接口联调",
  "- 负责人：林语",
  "- 优先级：高",
  "## 模块：订单",
  "### 功能：订单查询",
  "#### 任务：订单查询筛选",
  "- 负责人：张三",
].join("\n");

/** 只缺一个负责人：用来验证「还差 N 处」由确定性检查算出。 */
const MISSING_DOCUMENT = [
  "## 模块：支付",
  "### 功能：退款",
  "#### 任务：修复重复回调",
  "- 优先级：高",
].join("\n");

/** 一份要素齐全的模板草稿：负责人 / 项目成员都能对上目录，用来验证「要素完好」。 */
const COMPLETE_DOCUMENT = [
  "# 项目：商城结算系统",
  "- 项目编码：MALL",
  "- 项目说明：结算与对账",
  "- 项目成员：林雨",
  "## 模块：购物车",
  "- 说明：购物车增删改与价格试算",
  "### 功能：数量调整",
  "- 当前说明：支持直接改数量",
  "- 验收标准：改完数量后金额即时刷新",
  "- 标签：前端",
  "#### 任务：数量调整交互",
  "- 负责人：林雨",
  "- 优先级：高",
  "- 截止：2026-10-20",
  "- 描述：数量调整交互与金额联动",
].join("\n");

const DIRECTORY: readonly UserDirectoryItem[] = [
  {
    id: 1,
    name: "林雨",
    avatarUrl: null,
    isAdmin: false,
    organizations: [],
  },
  {
    id: 2,
    name: "陈昊",
    avatarUrl: null,
    isAdmin: false,
    organizations: [],
  },
];

const TARGET_MODULE: ModuleItem = {
  id: 7,
  projectId: 2,
  code: "MALL-M-1",
  name: "支付",
  description: "支付与退款",
  kind: "NORMAL",
  sortOrder: 0,
  rowVersion: 1,
  createdAt: "2026-10-22T00:00:00.000Z",
  updatedAt: "2026-10-22T00:00:00.000Z",
  stats: { activeFeatureCount: 1, openTaskCount: 0, completedTaskCount: 0 },
};

const TARGET_FEATURE: FeatureItem = {
  id: 8,
  projectId: 2,
  moduleId: 7,
  code: "MALL-F-1",
  createdBy: 1,
  tags: [],
  name: "退款回调",
  currentBehavior: "处理退款回调",
  acceptanceCriteria: "",
  rowVersion: 1,
  createdAt: "2026-10-22T00:00:00.000Z",
  updatedAt: "2026-10-22T00:00:00.000Z",
  stats: { openTaskCount: 0, completedTaskCount: 0, recordCount: 0 },
};

const TARGET_PROJECT: ProjectListItem = {
  id: 2,
  code: "MALL",
  name: "商城结算系统",
  description: "结算与对账",
  status: "ACTIVE",
  hasCompletedTask: false,
  rowVersion: 1,
  createdBy: 1,
  createdAt: "2026-10-22T00:00:00.000Z",
  updatedAt: "2026-10-22T00:00:00.000Z",
  memberCount: 2,
  stats: {
    activeModuleCount: 1,
    activeFeatureCount: 1,
    openTaskCount: 0,
    completedTaskCount: 0,
  },
  currentUserRole: "MEMBER",
};

const okAssist: DocumentImportAssistResponse = {
  markdown: ASSIST_MARKDOWN,
  model: "stub-model",
  issues: [],
};

const okPreview: ProjectDocumentImportPreviewResponse = {
  digest: "a".repeat(64),
  templateVersion: "1",
  project: null,
  summary: {
    moduleCount: 1,
    featureCount: 1,
    taskCount: 1,
    moduleCreateCount: 1,
    moduleReuseCount: 0,
    featureCreateCount: 1,
    featureReuseCount: 0,
    taskCreateCount: 1,
    memberAddCount: 0,
  },
  modules: [{ line: 4, name: "支付", action: "CREATE", moduleId: null }],
  features: [
    {
      line: 6,
      moduleName: "支付",
      name: "微信支付退款回调",
      action: "CREATE",
      featureId: null,
    },
  ],
  tasks: [
    {
      line: 8,
      scope: "FEATURE",
      moduleName: "支付",
      featureName: "微信支付退款回调",
      title: "修复重复回调",
      assignees: [{ token: "zhang", userId: 9, name: "张三" }],
      priority: "HIGH",
      dueAt: null,
    },
  ],
  issues: [],
  canApply: true,
  duplicate: null,
};

const okResult: ProjectDocumentImportResult = {
  projectId: 12,
  projectCode: "SHOP",
  digest: "a".repeat(64),
  counts: {
    modules: 1,
    features: 1,
    tasks: 1,
    reusedModules: 0,
    reusedFeatures: 0,
    addedMembers: 0,
  },
  modules: [{ id: 31, code: "SHOP-M-1" }],
  features: [{ id: 41, code: "SHOP-F-1", moduleId: 31 }],
  tasks: [
    {
      id: 51,
      code: "SHOP-T-1",
      moduleId: 31,
      featureId: 41,
      scopeType: "FEATURE",
    },
  ],
};

const adminUser: CurrentUserResponse = {
  id: 1,
  loginName: "admin",
  name: "管理员",
  email: null,
  avatarUrl: null,
  isAdmin: true,
  status: "ACTIVE",
};

function LocationProbe(): React.ReactElement {
  const location = useLocation();
  return (
    <div data-testid="location">{location.pathname + location.search}</div>
  );
}

interface MountOptions {
  readonly preview?: ProjectDocumentImportPreviewResponse | undefined;
  readonly previewError?: unknown;
  readonly applyError?: unknown;
  readonly assist?: DocumentImportAssistResponse | undefined;
  readonly assistError?: unknown;
  readonly mode?: DocumentImportMode | undefined;
  readonly allowModeSwitch?: boolean | undefined;
  readonly projects?: readonly ProjectListItem[] | undefined;
  readonly projectName?: string | undefined;
  readonly admin?: boolean | undefined;
  /** 登录用户；未指定时只有 admin: true 才注入管理员，其余保持未登录。 */
  readonly user?: CurrentUserResponse | null | undefined;
  readonly directory?: readonly UserDirectoryItem[] | undefined;
  readonly modules?: readonly ModuleItem[] | undefined;
  readonly features?: readonly FeatureItem[] | undefined;
}

function mount(options: MountOptions = {}) {
  const previewProjectDocumentImport =
    options.previewError === undefined
      ? vi.fn().mockResolvedValue(options.preview ?? okPreview)
      : vi.fn().mockRejectedValue(options.previewError);
  const importProjectDocument =
    options.applyError === undefined
      ? vi.fn().mockResolvedValue(okResult)
      : vi.fn().mockRejectedValue(options.applyError);
  const assistDocumentImport =
    options.assistError === undefined
      ? vi.fn().mockResolvedValue(options.assist ?? okAssist)
      : vi.fn().mockRejectedValue(options.assistError);
  const getUserDirectory = vi
    .fn()
    .mockResolvedValue({ items: options.directory ?? [] });
  const listModules = vi
    .fn()
    .mockResolvedValue({ items: options.modules ?? [] });
  const listFeatures = vi
    .fn()
    .mockResolvedValue({ items: options.features ?? [] });
  const issueCsrfToken = vi
    .fn()
    .mockResolvedValue({ csrfToken: "a".repeat(43) });
  const client = {
    issueCsrfToken,
    getUserDirectory,
    listModules,
    listFeatures,
    previewProjectDocumentImport,
    importProjectDocument,
    assistDocumentImport,
  } as unknown as InpulseApiClient;
  const onImported = vi.fn();
  const onClose = vi.fn();
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <AuthStateProvider
        value={{
          status: "authenticated",
          user:
            options.user === undefined
              ? options.admin
                ? adminUser
                : null
              : options.user,
        }}
      >
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <MemoryRouter>
            <DocumentImportModal
              open
              mode={options.mode ?? "PROJECT"}
              projectId={options.mode === "NEW_PROJECT" ? undefined : 2}
              allowModeSwitch={options.allowModeSwitch}
              projects={options.projects}
              projectName={options.projectName}
              client={client}
              onClose={onClose}
              onImported={onImported}
            />
            <LocationProbe />
          </MemoryRouter>
        </QueryClientProvider>
      </AuthStateProvider>
    </ConfigProvider>,
  );
  return {
    client,
    onImported,
    onClose,
    importProjectDocument,
    previewProjectDocumentImport,
    assistDocumentImport,
    getUserDirectory,
    listModules,
    listFeatures,
    issueCsrfToken,
  };
}

/** 左栏第一步：点「直接粘贴文本」，再写进文本页签。 */
function pasteDocument(document: string = DOCUMENT): void {
  fireEvent.click(screen.getByRole("button", { name: "直接粘贴文本" }));
  fireEvent.change(screen.getByLabelText("导入文档内容"), {
    target: { value: document },
  });
}

function pickFile(file: File): void {
  fireEvent.change(screen.getByLabelText("选择文档进行分析"), {
    target: { files: [file] },
  });
}

async function pickCalmSelectOption(
  label: string,
  optionTitle: string,
): Promise<void> {
  const trigger = screen.getByLabelText(label).closest(".ant-select");
  if (trigger === null) {
    throw new Error("select trigger not found for " + label);
  }
  fireEvent.mouseDown(trigger);
  fireEvent.click(await screen.findByTitle(optionTitle));
}

function importTextarea(): HTMLTextAreaElement {
  return screen.getByLabelText("导入文档内容") as HTMLTextAreaElement;
}

function previewButton(): HTMLButtonElement {
  return screen.getByTestId("document-import-preview") as HTMLButtonElement;
}

function composer(): HTMLInputElement {
  return screen.getByLabelText("补充说明") as HTMLInputElement;
}

function sendSupplement(text: string): void {
  fireEvent.change(composer(), { target: { value: text } });
  fireEvent.click(screen.getByTestId("document-import-assist-run"));
}

async function pasteAndPreview(document: string = DOCUMENT) {
  pasteDocument(document);
  fireEvent.click(previewButton());
  await screen.findByTestId("document-import-summary");
}

beforeEach(() => {
  extractDocumentTextMock.mockReset();
});

describe("ADR-094 项目列表入口的工作台内切换", () => {
  it("直接打开导入工作台，并在同一页面切换新建整项目与已有项目", async () => {
    const { listModules } = mount({
      mode: "NEW_PROJECT",
      allowModeSwitch: true,
      projects: [TARGET_PROJECT],
    });

    expect(
      screen.getByRole("dialog", { name: "从文档导入" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("document-import-mode")).toBeInTheDocument();
    expect(screen.getByLabelText("导入文档内容")).toBeInTheDocument();
    expect(
      screen
        .getByRole("button", { name: "新建项目" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.queryByTestId("document-import-target")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "导入已有项目" }));

    expect(
      await screen.findByTestId("document-import-target"),
    ).toBeInTheDocument();
    expect(
      screen
        .getByRole("button", { name: "导入已有项目" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(listModules).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ signal: expect.anything() }),
    );
  });
});

describe("ADR-064 文档导入弹窗（项目内导入）", () => {
  it("预览只读展示模块卡片计划，确认后先取 CSRF 再带幂等键执行并回调结果", async () => {
    const { client, onImported } = mount();
    await pasteAndPreview();

    expect(client.previewProjectDocumentImport).toHaveBeenCalledWith(2, {
      document: DOCUMENT,
    });
    expect(screen.getByText(/计划创建模块 1 个/)).toBeTruthy();
    const card = screen.getByText("支付").closest(".import-plan-card");
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText("新建模块")).toBeTruthy();
    expect(
      within(card as HTMLElement).getByText("微信支付退款回调"),
    ).toBeTruthy();
    expect(within(card as HTMLElement).getByText("新建功能")).toBeTruthy();
    expect(within(card as HTMLElement).getByText("修复重复回调")).toBeTruthy();
    expect(within(card as HTMLElement).getByText("张三 · 高")).toBeTruthy();

    fireEvent.click(screen.getByTestId("document-import-apply"));

    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
    expect(onImported).toHaveBeenCalledWith(okResult);
    expect(client.importProjectDocument).toHaveBeenCalledWith(
      2,
      { document: DOCUMENT, expectedDigest: okPreview.digest },
      {
        headers: {
          "x-csrf-token": "a".repeat(43),
          "Idempotency-Key": expect.stringMatching(/^document-import-/),
        },
      },
    );
  });

  it("存在 ERROR 行级问题时确认导入禁用并展示问题清单", async () => {
    mount({
      preview: {
        ...okPreview,
        canApply: false,
        issues: [
          {
            severity: "ERROR",
            line: 3,
            code: "MISSING_FEATURE_SECTION",
            message: "功能缺少当前说明",
          },
        ],
      },
    });
    await pasteAndPreview();

    expect(screen.getByText("第 3 行：功能缺少当前说明")).toBeTruthy();
    const apply = screen.getByTestId("document-import-apply");
    expect((apply as HTMLButtonElement).disabled).toBe(true);
  });

  it("预览阶段点右上角叉只关闭预览：弹窗与草稿都留着，不整个关掉", async () => {
    const { onClose } = mount({
      preview: {
        ...okPreview,
        canApply: false,
        issues: [
          {
            severity: "ERROR",
            line: 3,
            code: "MISSING_FEATURE_SECTION",
            message: "功能缺少当前说明",
          },
        ],
      },
    });
    await pasteAndPreview();

    fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));

    expect(onClose).not.toHaveBeenCalled();
    expect(importTextarea().value).toBe(DOCUMENT);
    expect(previewButton()).toBeTruthy();
    expect(screen.queryByTestId("document-import-summary")).toBeNull();
    expect(screen.queryByText("第 3 行：功能缺少当前说明")).toBeNull();
  });

  it("工作台阶段点叉仍然是关掉整个导入弹窗", () => {
    const { onClose } = mount();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("同一文档已导入过时给出重复提示并禁用确认", async () => {
    mount({
      preview: {
        ...okPreview,
        canApply: false,
        duplicate: {
          projectId: 12,
          importedAt: "2026-10-10T00:00:00.000Z",
          actorName: "张三",
        },
      },
    });
    await pasteAndPreview();

    expect(screen.getByText("该文档已导入过，不能重复导入。")).toBeTruthy();
    const apply = screen.getByTestId("document-import-apply");
    expect((apply as HTMLButtonElement).disabled).toBe(true);
  });

  it("预览 422 时展示行级问题与固定错误文案", async () => {
    mount({
      previewError: new ApiError(422, {
        code: "DOCUMENT_IMPORT_INVALID",
        message: "文档校验失败",
        details: {
          issues: [
            {
              severity: "ERROR",
              line: 2,
              code: "MISSING_PROJECT_CODE",
              message: "缺少项目编码",
            },
          ],
        },
        requestId: "test",
      }),
    });
    pasteDocument();
    fireEvent.click(previewButton());

    expect(await screen.findByText("第 2 行：缺少项目编码")).toBeTruthy();
    expect(
      screen.getByText("文档存在错误，请修正问题清单后重新预览。"),
    ).toBeTruthy();
  });

  it("执行时摘要过期（409）退回输入阶段重新预览", async () => {
    const { onImported } = mount({
      applyError: new ApiError(409, {
        code: "DOCUMENT_IMPORT_STALE",
        message: "stale",
        details: {},
        requestId: "test",
      }),
    });
    await pasteAndPreview();
    fireEvent.click(screen.getByTestId("document-import-apply"));

    expect(
      await screen.findByText("文档内容与预览结果不一致，请重新预览后再导入。"),
    ).toBeTruthy();
    expect(previewButton()).toBeTruthy();
    expect(onImported).not.toHaveBeenCalled();
  });

  it("没有内容时预览按钮置灰，不发请求（ADR-071 空态）", async () => {
    const { client } = mount();
    expect(previewButton().disabled).toBe(true);
    expect(client.previewProjectDocumentImport).not.toHaveBeenCalled();
  });

  it("展示必填要素说明：逐项列出要提供的要素与层级，且不再出现「格式速查」（ADR-065）", () => {
    mount();
    const guide = screen.getByTestId("document-import-format-guide");
    expect(guide.textContent).toContain("必填要素");
    expect(guide.textContent).toContain("项目名称");
    expect(guide.textContent).toContain("项目编码");
    expect(guide.textContent).toContain("负责人");
    expect(guide.textContent).toContain(
      "参加人员（填写姓名，须包含创建者本人与全部任务负责人）",
    );
    expect(guide.textContent).toContain(
      "功能隶属于模块，任务可隶属于模块或功能",
    );
    expect(guide.textContent).not.toContain("缺失时导入会被拒绝");
    expect(guide.textContent).not.toContain("格式速查");
    expect(DOCUMENT_IMPORT_TEMPLATE).toContain("项目编码");
    expect(DOCUMENT_IMPORT_TEMPLATE).toContain("负责人（必填");
    expect(DOCUMENT_IMPORT_TEMPLATE).toContain(
      "说明行（以 > 开头）与代码围栏行",
    );
    expect(DOCUMENT_IMPORT_TEMPLATE).toContain("不要自创、不要改名");
  });

  it("选择 .md 文件后本地读取、剥离 BOM，并直接按模板解析（ADR-066）", async () => {
    const { client, assistDocumentImport } = mount();
    extractDocumentTextMock.mockResolvedValue({
      fileName: "商城系统.md",
      text: DOCUMENT,
      warning: null,
    });

    pickFile(
      new File(["\uFEFF" + DOCUMENT], "商城系统.md", {
        type: "text/markdown",
      }),
    );

    await waitFor(() => expect(importTextarea().value).toBe(DOCUMENT));
    // 已经是模板：本地解析即可，不消耗模型。
    expect(assistDocumentImport).not.toHaveBeenCalled();

    fireEvent.click(previewButton());
    await screen.findByTestId("document-import-summary");
    expect(client.previewProjectDocumentImport).toHaveBeenCalledWith(2, {
      document: DOCUMENT,
    });
  });

  it("不支持的文档类型本地拒绝且不发请求（ADR-066）", async () => {
    const { client, assistDocumentImport } = mount();
    extractDocumentTextMock.mockRejectedValue(
      new DocumentExtractionError("UNSUPPORTED_TYPE"),
    );

    pickFile(new File(["old-doc"], "旧文档.doc"));

    expect(
      await screen.findByText(
        /仅支持 .txt、.md、.markdown、.docx 或 .pdf 文件/,
      ),
    ).toBeTruthy();
    expect(assistDocumentImport).not.toHaveBeenCalled();
    expect(client.previewProjectDocumentImport).not.toHaveBeenCalled();
    expect(importTextarea().value).toBe("");
  });

  it("超过 20 MB 的文件本地拒绝（ADR-071 与 ADR-067 统一上限）", async () => {
    const { client } = mount();
    extractDocumentTextMock.mockRejectedValue(
      new DocumentExtractionError("FILE_TOO_LARGE"),
    );

    pickFile(new File(["x"], "big.md", { type: "text/markdown" }));

    expect(
      await screen.findByText(
        "文件超过 20 MB 上限，请精简后重试或直接粘贴内容。",
      ),
    ).toBeTruthy();
    expect(client.previewProjectDocumentImport).not.toHaveBeenCalled();
  });
});

describe("ADR-071 左右分栏工作台", () => {
  it("空态：左栏拖入区、右栏空对话、输入与预览都不可用", () => {
    mount();
    expect(screen.getByRole("button", { name: "直接粘贴文本" })).toBeTruthy();
    expect(
      screen.getByText(/文件只在浏览器本地抽取文本，原文件不会上传/),
    ).toBeTruthy();
    expect(screen.getByText("还没有对话")).toBeTruthy();
    expect(screen.getByText(/把文档交给左侧开始分析后/)).toBeTruthy();
    expect(composer().disabled).toBe(true);
    expect(previewButton().disabled).toBe(true);
  });

  it("点「直接粘贴文本」后光标直接落在文本区，可以立刻粘贴", async () => {
    mount();

    fireEvent.click(screen.getByRole("button", { name: "直接粘贴文本" }));

    // 进去就能 Ctrl+V：不用先点一下输入框。
    await waitFor(() => expect(document.activeElement).toBe(importTextarea()));
  });

  it("空态直接 Ctrl+V：剪贴板文本一步落进粘贴框", async () => {
    mount();

    fireEvent.paste(window, {
      clipboardData: { getData: () => WORKBENCH_DOCUMENT },
    });

    await waitFor(() => expect(document.activeElement).toBe(importTextarea()));
    expect(importTextarea()).toHaveValue(WORKBENCH_DOCUMENT);
  });

  it("粘贴模板后左栏按层级渲染结构化草稿，右栏给出规模计数", async () => {
    mount({ directory: DIRECTORY });
    pasteDocument(WORKBENCH_DOCUMENT);

    expect(screen.getByText("商城结算系统")).toBeTruthy();
    expect(screen.getByText("购物车")).toBeTruthy();
    expect(screen.getByText("数量调整")).toBeTruthy();
    expect(screen.getByText("数量调整交互")).toBeTruthy();
    expect(
      within(screen.getByTestId("document-import-assist")).getByText(
        "已整理 2 模块 · 2 功能 · 3 任务",
      ),
    ).toBeTruthy();
    // 直接粘贴的模板不触发模型调用。
    expect(screen.getByTestId("document-import-assist")).toBeTruthy();
  });

  it("点哪改哪：点字段变输入框，回车把值写回文本", () => {
    mount({ directory: DIRECTORY });
    pasteDocument(WORKBENCH_DOCUMENT);

    fireEvent.click(screen.getByRole("button", { name: "购物车：说明" }));
    const editor = screen.getByLabelText("购物车：说明");
    fireEvent.change(editor, {
      target: { value: "购物车增删改与价格试算（含运费）" },
    });
    fireEvent.keyDown(editor, { key: "Enter" });

    const lines = importTextarea().value.split("\n");
    expect(lines).toContain("- 说明：购物车增删改与价格试算（含运费）");
    expect(lines).not.toContain("- 说明：购物车增删改与价格试算");
  });

  it("缺的字段可以补：点「＋说明」插入空字段行并直接编辑", () => {
    mount({ directory: DIRECTORY });
    pasteDocument(WORKBENCH_DOCUMENT);

    expect(importTextarea().value).not.toContain("- 说明：\n");
    fireEvent.click(screen.getByRole("button", { name: "订单：添加说明" }));

    const editor = screen.getByLabelText("订单：说明");
    fireEvent.change(editor, { target: { value: "订单创建、支付状态与查询" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(importTextarea().value).toContain(
      "## 模块：订单\n- 说明：订单创建、支付状态与查询",
    );
    // 补上以后入口就消失，不再重复插入。
    expect(screen.queryByRole("button", { name: "订单：添加说明" })).toBeNull();
  });

  it("「＋字段」入口区分必填与可选：负责人 / 项目编码 / 项目成员都标「必填」", () => {
    mount({ directory: DIRECTORY, mode: "NEW_PROJECT" });
    pasteDocument(
      [
        "# 项目：商城系统",
        "## 模块：支付",
        "### 功能：退款",
        "#### 任务：修复重复回调",
      ].join("\n"),
    );

    // 必填（服务端会拒绝）：任务负责人、整项目导入的项目编码。
    expect(
      screen.getByRole("button", { name: "修复重复回调：添加负责人（必填）" })
        .textContent,
    ).toBe("＋负责人（必填）");
    expect(
      screen.getByRole("button", { name: "项目：添加项目编码（必填）" })
        .textContent,
    ).toBe("＋项目编码（必填）");
    expect(
      screen.getByRole("button", { name: "项目：添加项目编码（必填）" })
        .className,
    ).toContain("is-required");
    // ADR-072：整项目导入的项目成员必填。
    const member = screen.getByRole("button", {
      name: "项目：添加项目成员（必填）",
    });
    expect(member.textContent).toBe("＋项目成员（必填）");
    expect(member.className).toContain("is-required");
    // 可选（补不补都能导入）：项目说明保持素色，不出现「必填」字样。
    const description = screen.getByRole("button", {
      name: "项目：添加项目说明",
    });
    expect(description.textContent).toBe("＋项目说明");
    expect(description.className).not.toContain("is-required");
  });

  it("内容梳理 / 预览文档两个页签切换，文本页签显示完整原文", () => {
    mount({ directory: DIRECTORY });
    pasteDocument(WORKBENCH_DOCUMENT);

    // 点「直接粘贴文本」进来时停在文本页签上。
    expect(importTextarea().value).toBe(WORKBENCH_DOCUMENT);
    expect(screen.getByTestId("document-import-draft").className).toContain(
      "is-hidden",
    );

    fireEvent.click(screen.getByRole("button", { name: "内容梳理" }));
    expect(screen.getByTestId("document-import-draft").className).not.toContain(
      "is-hidden",
    );

    fireEvent.click(screen.getByRole("button", { name: "预览文档" }));
    expect(screen.getByTestId("document-import-draft").className).toContain(
      "is-hidden",
    );

    fireEvent.click(screen.getByRole("button", { name: "内容梳理" }));
    expect(screen.getByTestId("document-import-draft").className).not.toContain(
      "is-hidden",
    );
  });

  it("「还差 N 处」与缺失标签由确定性检查算出（不依赖模型）", () => {
    mount({ directory: DIRECTORY });
    pasteDocument(MISSING_DOCUMENT);

    const assistant = screen.getByTestId("document-import-assist");
    expect(within(assistant).getByText("还差 1 处")).toBeTruthy();
    expect(within(assistant).getByText("缺负责人 ×1")).toBeTruthy();
  });

  it("助手主动报告还缺什么：不重复头部的规模计数", async () => {
    mount({ directory: DIRECTORY });
    extractDocumentTextMock.mockResolvedValue({
      fileName: "支付.md",
      text: MISSING_DOCUMENT,
      warning: null,
    });

    pickFile(new File(["x"], "支付.md"));

    const messages = await screen.findByTestId(
      "document-import-assist-messages",
    );
    await waitFor(() =>
      expect(messages.textContent ?? "").toContain(
        "必填还差 1 处：缺负责人 ×1（修复重复回调）",
      ),
    );
    const text = messages.textContent ?? "";
    expect(text).toContain(
      "另有 4 处建议补齐：模块说明 ×1（支付）、功能说明 ×1（退款）、截止时间 ×1（修复重复回调）、任务描述 ×1（修复重复回调）",
    );
    // 规模计数只在头部显示一次，助手不再重复。
    expect(text).not.toContain("已整理");
  });

  it("导入落地后助手主动汇报一次：还差多少处要补、多少名字待确认", async () => {
    mount({ directory: DIRECTORY });
    extractDocumentTextMock.mockResolvedValue({
      fileName: "结算.md",
      text: WORKBENCH_DOCUMENT,
      warning: null,
    });

    pickFile(new File(["x"], "结算.md"));

    const messages = await screen.findByTestId(
      "document-import-assist-messages",
    );
    await waitFor(() =>
      expect(messages.textContent ?? "").toContain(
        "已进入内容梳理：需要补充 8 处、待确认 2 个名字。",
      ),
    );
  });

  it("要素完好时助手改为报告「要素完好」", async () => {
    mount({ directory: DIRECTORY });
    extractDocumentTextMock.mockResolvedValue({
      fileName: "完整.md",
      text: COMPLETE_DOCUMENT,
      warning: null,
    });

    pickFile(new File(["x"], "完整.md"));

    const messages = await screen.findByTestId(
      "document-import-assist-messages",
    );
    await waitFor(() =>
      expect(messages.textContent ?? "").toContain(
        "已进入内容梳理：要素完好，可以直接点「预览」导入。",
      ),
    );
  });

  it("直接粘贴的结构化草稿同样汇报一次，手改字段不重复刷屏", async () => {
    mount({ directory: DIRECTORY });
    pasteDocument(WORKBENCH_DOCUMENT);

    const messages = await screen.findByTestId(
      "document-import-assist-messages",
    );
    await waitFor(() =>
      expect(messages.textContent ?? "").toContain(
        "已进入内容梳理：需要补充 8 处、待确认 2 个名字。",
      ),
    );
    expect((messages.textContent ?? "").match(/已进入内容梳理/gu)?.length).toBe(
      1,
    );

    // 手改一个字段不该再冒出一条汇报。
    fireEvent.click(screen.getByRole("button", { name: "模块名称：购物车" }));
    const editor = screen.getByLabelText("模块名称：购物车");
    fireEvent.change(editor, { target: { value: "购物车与结算" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() =>
      expect(
        screen.getByTestId("document-import-draft").textContent ?? "",
      ).toContain("购物车与结算"),
    );
    expect((messages.textContent ?? "").match(/已进入内容梳理/gu)?.length).toBe(
      1,
    );
  });

  it("助手结论实时跟随草稿：补上必填后立刻改口", async () => {
    mount({ directory: DIRECTORY });
    pasteDocument(MISSING_DOCUMENT);

    const verdict = (): string =>
      screen.getByTestId("document-import-assist-verdict").textContent ?? "";
    expect(verdict()).toContain("必填还差 1 处：缺负责人 ×1（修复重复回调）");

    // 点「＋负责人」补上必填，助手那句话应当立刻改口，而不是停在旧结论上。
    fireEvent.click(
      screen.getByRole("button", { name: "修复重复回调：添加负责人（必填）" }),
    );
    const editor = screen.getByLabelText("修复重复回调：负责人");
    fireEvent.change(editor, { target: { value: "林雨" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() => expect(verdict()).not.toContain("必填还差"));
    expect(verdict()).toContain(
      "另有 4 处建议补齐：模块说明 ×1（支付）、功能说明 ×1（退款）、截止时间 ×1（修复重复回调）、任务描述 ×1（修复重复回调）",
    );
  });

  it("自由正文可以点「交给 AI 整理」交给模型归纳，且不再弹覆盖确认", async () => {
    const { assistDocumentImport } = mount({ directory: DIRECTORY });
    pasteDocument("这周要把订单查询做完，负责人是林雨。");

    fireEvent.click(screen.getByTestId("document-import-assist-run-raw"));

    await waitFor(() =>
      expect(assistDocumentImport).toHaveBeenCalledWith({
        mode: "IN_PROJECT",
        target: { projectId: 2, moduleId: null, featureId: null },
        text: "这周要把订单查询做完，负责人是林雨。",
      }),
    );
    // 整理结果直接落回左栏，任何入口都不再弹覆盖确认。
    expect(
      screen.queryByRole("dialog", { name: /覆盖左侧草稿当前内容/ }),
    ).toBeNull();
    await waitFor(() =>
      expect(screen.getByLabelText("项目名称").textContent).toBe("商城系统"),
    );
    // 已经有结构了，入口随之消失。
    expect(screen.queryByTestId("document-import-assist-run-raw")).toBeNull();
  });

  it("项目内导入可选模块与功能，目标随补充说明保持一致", async () => {
    const { assistDocumentImport, listFeatures } = mount({
      projectName: "商城结算系统",
      directory: DIRECTORY,
      modules: [TARGET_MODULE],
      features: [TARGET_FEATURE],
    });
    expect(screen.getByTestId("document-import-target")).toBeTruthy();
    expect(screen.queryByTestId("document-import-mode")).toBeNull();

    // 固定项目入口：项目名只作上下文展示，不能在这里切换项目。
    const projectContext = screen.getByTestId("document-import-project");
    expect(projectContext.textContent).toContain("商城结算系统");
    expect(projectContext.getAttribute("title")).toBe("商城结算系统");
    expect(projectContext.querySelector("[role=combobox]")).toBeNull();
    expect(projectContext.closest("button, [role=button]")).toBeNull();

    await pickCalmSelectOption("所属模块", "支付");
    await waitFor(() => expect(listFeatures).toHaveBeenCalled());
    await pickCalmSelectOption("所属功能", "退款回调");

    expect(
      screen.getByTestId("document-import-target-summary").textContent,
    ).toContain("支付 / 退款回调");

    pasteDocument("退款回调要补一条超时重试。");
    fireEvent.click(screen.getByTestId("document-import-assist-run-raw"));

    await waitFor(() =>
      expect(assistDocumentImport).toHaveBeenNthCalledWith(1, {
        mode: "IN_PROJECT",
        target: { projectId: 2, moduleId: 7, featureId: 8 },
        text: "退款回调要补一条超时重试。",
      }),
    );

    sendSupplement("再加一条告警通知");
    await waitFor(() => {
      const calls = assistDocumentImport.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(calls[1]?.[0]).toMatchObject({
        mode: "IN_PROJECT",
        target: { projectId: 2, moduleId: 7, featureId: 8 },
      });
    });
  });

  it("还没有结构化内容时，助手说的是「还没整理成模板结构」", () => {
    mount({ directory: DIRECTORY });
    pasteDocument("这周要把订单查询做完，负责人是林雨。");

    expect(
      screen.getByTestId("document-import-assist-verdict").textContent,
    ).toContain("还没整理成模板结构");
    // 有内容后空态让位给实时结论。
    expect(screen.queryByText("还没有对话")).toBeNull();
  });

  it("名字对不上账号时右栏追问并给候选，点候选把「旧名改成新名」作为补充说明重发", async () => {
    const { assistDocumentImport } = mount({ directory: DIRECTORY });
    pasteDocument(WORKBENCH_DOCUMENT);

    const panel = await screen.findByTestId("document-import-unmatched");
    expect(
      within(panel).getByText("有 2 个名字没匹配到成员姓名，导入前请确认"),
    ).toBeTruthy();
    expect(within(panel).getByText("林语")).toBeTruthy();
    expect(within(panel).getByText("张三")).toBeTruthy();
    expect(await screen.findByText(/还有 2 个名字对不上成员账号/)).toBeTruthy();

    fireEvent.click(within(panel).getByRole("button", { name: /^林\s*雨$/ }));

    await waitFor(() =>
      expect(assistDocumentImport).toHaveBeenCalledWith({
        mode: "IN_PROJECT",
        target: { projectId: 2, moduleId: null, featureId: null },
        text: WORKBENCH_DOCUMENT + "\n\n补充说明：「林语」改成「林雨」",
      }),
    );
    // 点候选也是一句补充说明：AI 结果直接落回左栏，不再弹覆盖确认（用户「不要每次都问一下」）。
    expect(
      screen.queryByRole("dialog", { name: /覆盖左侧草稿当前内容/ }),
    ).toBeNull();
    // AI 改写只进「内容梳理」草稿；「预览文档」保留本地抽出的原文。
    await waitFor(() =>
      expect(screen.getByLabelText("项目名称").textContent).toBe("商城系统"),
    );
  });

  it("「从成员里挑」支持按姓名里的一个字筛选（用户「打一个字就筛出来」）", async () => {
    mount({ directory: DIRECTORY });
    pasteDocument(WORKBENCH_DOCUMENT);

    const panel = await screen.findByTestId("document-import-unmatched");
    const row = within(panel)
      .getByText("林语")
      .closest(".import-unmatched-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "从成员里挑" }));

    const picker = row.querySelector(".import-member-picker") as HTMLElement;
    const search = within(picker).getByLabelText("搜索成员");
    // 没输入时名单是完整的（antd 会在两个汉字之间插空格，所以按钮名用正则）。
    expect(
      within(picker).getByRole("button", { name: /^林\s*雨$/ }),
    ).toBeTruthy();
    expect(
      within(picker).getByRole("button", { name: /^陈\s*昊$/ }),
    ).toBeTruthy();

    // 打一个字：只留名字里带这个字的人。
    fireEvent.change(search, { target: { value: "陈" } });
    expect(
      within(picker).getByRole("button", { name: /^陈\s*昊$/ }),
    ).toBeTruthy();
    expect(
      within(picker).queryByRole("button", { name: /^林\s*雨$/ }),
    ).toBeNull();

    // 一个字都匹配不上时给一句明确的空态，而不是空白面板。
    fireEvent.change(search, { target: { value: "赵" } });
    expect(
      within(picker).getByText("没有匹配的成员，换个字再试。"),
    ).toBeTruthy();
  });

  it("补充说明与原始文档拼成一段重新分析，仍然只调同一条路由", async () => {
    const { assistDocumentImport } = mount({ directory: DIRECTORY });
    pasteDocument(WORKBENCH_DOCUMENT);

    sendSupplement("订单查询要在本周五前完成");

    await waitFor(() =>
      expect(assistDocumentImport).toHaveBeenCalledWith({
        mode: "IN_PROJECT",
        target: { projectId: 2, moduleId: null, featureId: null },
        text: WORKBENCH_DOCUMENT + "\n\n补充说明：订单查询要在本周五前完成",
      }),
    );
    expect(screen.getByText("订单查询要在本周五前完成")).toBeTruthy();
  });

  it("模型没落地前不再先报一次旧缺口：同屏不会出现「还差 N 处」又「已更新」", async () => {
    const { assistDocumentImport } = mount({
      directory: DIRECTORY,
      assist: { markdown: MISSING_DOCUMENT, model: "stub-model", issues: [] },
    });
    // 走文件入口：AI 草稿直接成为「已应用」的草稿，补充说明不再弹覆盖确认。
    extractDocumentTextMock.mockResolvedValue({
      fileName: "支付.md",
      text: "支付模块的原始需求正文",
      warning: null,
    });
    pickFile(new File(["x"], "支付.md"));
    await waitFor(() => expect(assistDocumentImport).toHaveBeenCalledTimes(1));

    // 这一轮模型挂住不返回：此刻不该冒出「必填还差…」这种按用户发言前草稿算出的结论，
    // 否则模型落地后再报「已按补充说明更新草稿：…负责人：特哥」，同屏两句就是自打脸
    // （2026-10-16 实测反馈）。等待期间由 busy 提示「正在让 AI 整理…」顶上。
    assistDocumentImport.mockImplementation(() => new Promise(() => undefined));
    sendSupplement("要补充什么");

    expect(screen.getByTestId("document-import-assist-busy")).toBeTruthy();
    // 顶部常驻结论本来就会一直在那里报缺口，这里只看「对话气泡」：
    // 模型没落地前，对话里不能再冒出一条按旧草稿算出的「必填还差…」。
    const bubbles = Array.from(
      screen.getByTestId("document-import-assist-messages").children,
    )
      .filter(
        (node) =>
          node.getAttribute("data-testid") !== "document-import-assist-verdict",
      )
      .map((node) => node.textContent ?? "");
    expect(bubbles.filter((text) => text.includes("必填还差"))).toHaveLength(0);
    expect(
      bubbles.filter((text) => text.includes("我重新核对了一遍")),
    ).toHaveLength(0);
    // 用户那一句必须已经入列，不能点了发送毫无反应。
    expect(screen.getByText("要补充什么")).toBeTruthy();
  });

  it("模型落地后只发一条汇报：先说左栏改了什么，再补还差的必填缺口", async () => {
    const { assistDocumentImport } = mount({
      directory: DIRECTORY,
      // AI 草稿里留一个缺负责人的任务，落地汇报才有具体缺口可点。
      assist: { markdown: MISSING_DOCUMENT, model: "stub-model", issues: [] },
    });
    extractDocumentTextMock.mockResolvedValue({
      fileName: "支付.md",
      text: "支付模块的原始需求正文",
      warning: null,
    });
    pickFile(new File(["x"], "支付.md"));
    await waitFor(() => expect(assistDocumentImport).toHaveBeenCalledTimes(1));

    // 模型原样返回：这一轮只发一条气泡，先如实说清「草稿没有变化」，再补必填缺口。
    assistDocumentImport.mockResolvedValue({
      markdown: MISSING_DOCUMENT,
      model: "stub-model",
      issues: [],
    });
    sendSupplement("要补充什么");

    const reply = await screen.findByText(/这一轮草稿没有变化/);
    expect(reply.textContent).toContain(
      "必填还差 1 处：缺负责人 ×1（修复重复回调）",
    );
    // 建议补齐（WARNING）不在每轮回复里复读：那些项由顶部常驻结论与下方标签承载。
    expect(reply.textContent).not.toContain("建议补齐");
    // 用户那一句与助手回复各自成一条气泡，且回复在后。
    const messages = screen.getByTestId("document-import-assist-messages");
    const bubbles = Array.from(messages.children).map(
      (node) => node.textContent ?? "",
    );
    const userIndex = bubbles.findIndex((text) => text.includes("要补充什么"));
    const replyIndex = bubbles.findIndex((text) =>
      text.includes("这一轮草稿没有变化"),
    );
    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(replyIndex).toBeGreaterThan(userIndex);
  });

  it("缺口状态没变时不再重复念同一句缺口结论（用户「这句话为什么一直重复？」）", async () => {
    const { assistDocumentImport } = mount({
      directory: DIRECTORY,
      assist: { markdown: MISSING_DOCUMENT, model: "stub-model", issues: [] },
    });
    extractDocumentTextMock.mockResolvedValue({
      fileName: "支付.md",
      text: "支付模块的原始需求正文",
      warning: null,
    });
    pickFile(new File(["x"], "支付.md"));
    await waitFor(() => expect(assistDocumentImport).toHaveBeenCalledTimes(1));

    // 模型每轮都原样返回同一份草稿：必填缺口一直是「缺负责人 ×1」。
    assistDocumentImport.mockResolvedValue({
      markdown: MISSING_DOCUMENT,
      model: "stub-model",
      issues: [],
    });
    sendSupplement("要补充什么");
    await screen.findByText(/这一轮草稿没有变化/);
    await waitFor(() =>
      expect(screen.queryByTestId("document-import-assist-busy")).toBeNull(),
    );

    const before = assistDocumentImport.mock.calls.length;
    sendSupplement("还有要补充的吗");
    await waitFor(() =>
      expect(assistDocumentImport.mock.calls.length).toBeGreaterThan(before),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("document-import-assist-busy")).toBeNull(),
    );

    const bubbles = Array.from(
      screen.getByTestId("document-import-assist-messages").children,
    )
      .filter(
        (node) =>
          node.getAttribute("data-testid") !== "document-import-assist-verdict",
      )
      .map((node) => node.textContent ?? "");
    // 两轮都如实回报了「草稿没有变化」，但同一句缺口结论只念一次。
    expect(
      bubbles.filter((text) => text.includes("草稿没有变化")),
    ).toHaveLength(2);
    expect(bubbles.filter((text) => text.includes("必填还差"))).toHaveLength(1);
  });
  it("只剩建议项时不再每轮复读建议清单（用户「这个可选择性的补充重复次数太多了」）", async () => {
    const { assistDocumentImport } = mount({
      directory: DIRECTORY,
      assist: {
        markdown: SUGGEST_ONLY_DOCUMENT,
        model: "stub-model",
        issues: [],
      },
    });
    extractDocumentTextMock.mockResolvedValue({
      fileName: "支付.md",
      text: "支付模块的原始需求正文",
      warning: null,
    });
    pickFile(new File(["x"], "支付.md"));
    await waitFor(() => expect(assistDocumentImport).toHaveBeenCalledTimes(1));

    assistDocumentImport.mockResolvedValue({
      markdown: SUGGEST_ONLY_DOCUMENT,
      model: "stub-model",
      issues: [],
    });
    sendSupplement("要补充什么");
    const reply = await screen.findByText(/这一轮草稿没有变化/);
    // 必填齐了就只说左栏改了什么，建议项不再跟着念一遍（顶部常驻结论里已经逐条点名）。
    expect(reply.textContent).not.toContain("建议补齐");
    expect(reply.textContent).not.toContain("必填还差");
    await waitFor(() =>
      expect(screen.queryByTestId("document-import-assist-busy")).toBeNull(),
    );

    const before = assistDocumentImport.mock.calls.length;
    sendSupplement("还有要补充的吗");
    await waitFor(() =>
      expect(assistDocumentImport.mock.calls.length).toBeGreaterThan(before),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("document-import-assist-busy")).toBeNull(),
    );

    // 只动建议项：既不再念缺口，也不让同一句多出一条。
    const bubbles = Array.from(
      screen.getByTestId("document-import-assist-messages").children,
    )
      .filter(
        (node) =>
          node.getAttribute("data-testid") !== "document-import-assist-verdict",
      )
      .map((node) => node.textContent ?? "");
    expect(bubbles.filter((text) => text.includes("必填还差"))).toHaveLength(0);
    expect(bubbles.filter((text) => text.includes("建议补齐"))).toHaveLength(0);
  });
});

describe("ADR-067 AI 辅助转换区块", () => {
  it("选择文档后本地抽取、自动分析，草稿填入左栏并展示问题清单", async () => {
    const { assistDocumentImport } = mount({
      directory: DIRECTORY,
      assist: {
        markdown: ASSIST_MARKDOWN,
        model: "stub-model",
        issues: [
          {
            severity: "WARNING",
            line: 2,
            code: "MISSING_OWNER",
            message: "任务缺少负责人",
          },
        ],
      },
    });
    extractDocumentTextMock.mockResolvedValue({
      fileName: "需求文档.docx",
      text: "支付模块需要退款回调能力，负责人张三。",
      warning: null,
    });

    pickFile(new File(["docx-bytes"], "需求文档.docx"));

    await waitFor(() =>
      expect(assistDocumentImport).toHaveBeenCalledWith({
        mode: "IN_PROJECT",
        target: { projectId: 2, moduleId: null, featureId: null },
        text: "支付模块需要退款回调能力，负责人张三。",
      }),
    );
    expect(extractDocumentTextMock).toHaveBeenCalledTimes(1);
    // AI 改写只进「内容梳理」草稿；「预览文档」保留本地抽出的原文。
    await waitFor(() =>
      expect(screen.getByLabelText("项目名称").textContent).toBe("商城系统"),
    );
    // 「预览文档」仍只读展示本地抽出的原文。
    fireEvent.click(screen.getByRole("button", { name: "预览文档" }));
    expect(importTextarea().value).toBe(
      "支付模块需要退款回调能力，负责人张三。",
    );
    expect(importTextarea().readOnly).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "内容梳理" }));
    expect(
      screen.getByTestId("document-import-assist-source").textContent,
    ).toContain("需求文档.docx");
    expect(
      await screen.findByText("AI 草稿第 2 行：任务缺少负责人"),
    ).toBeTruthy();
  });

  it("整项目入口的分析请求使用 WHOLE_PROJECT 模式", async () => {
    const { assistDocumentImport } = mount({ mode: "NEW_PROJECT" });
    expect(screen.queryByTestId("document-import-target")).toBeNull();
    extractDocumentTextMock.mockResolvedValue({
      fileName: "需求.md",
      text: "整项目需求文本",
      warning: null,
    });

    pickFile(new File(["x"], "需求.md"));

    await waitFor(() =>
      expect(assistDocumentImport).toHaveBeenCalledWith({
        mode: "WHOLE_PROJECT",
        text: "整项目需求文本",
      }),
    );
    // AI 改写只进「内容梳理」草稿；「预览文档」保留本地抽出的原文。
    await waitFor(() =>
      expect(screen.getByLabelText("项目名称").textContent).toBe("商城系统"),
    );
  });

  it("手改过左栏后不再二次确认：AI 结果直接落回左栏，且分析输入带上手改内容", async () => {
    const { assistDocumentImport } = mount({ directory: DIRECTORY });
    pasteDocument(WORKBENCH_DOCUMENT);
    // 手改一处，让草稿偏离系统写入的那一份。
    fireEvent.click(screen.getByRole("button", { name: "模块名称：订单" }));
    const editor = screen.getByLabelText("模块名称：订单");
    fireEvent.change(editor, { target: { value: "订单中心" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    const edited = importTextarea().value;
    expect(edited).toContain("模块：订单中心");

    sendSupplement("补充一句");

    // 分析输入取当前草稿：手改内容一起交给 AI，因此不再需要「要不要覆盖」的二次确认。
    await waitFor(() =>
      expect(assistDocumentImport).toHaveBeenCalledWith({
        mode: "IN_PROJECT",
        target: { projectId: 2, moduleId: null, featureId: null },
        text: edited + "\n\n补充说明：补充一句",
      }),
    );
    expect(
      screen.queryByRole("dialog", { name: /覆盖左侧草稿当前内容/ }),
    ).toBeNull();
    // AI 改写只进「内容梳理」草稿；「预览文档」保留首次分析前的原文。
    await waitFor(() =>
      expect(screen.getByLabelText("项目名称").textContent).toBe("商城系统"),
    );
  });

  it("发完一句后说清这一轮改了什么（用户不用自己去左栏里找）", async () => {
    const { assistDocumentImport } = mount({
      directory: DIRECTORY,
      assist: {
        markdown: WORKBENCH_DOCUMENT + "\n- 截止：2026-10-30",
        model: "stub-model",
        issues: [],
      },
    });
    pasteDocument(WORKBENCH_DOCUMENT);

    sendSupplement("联调要在 10 月 30 日前完成");

    await waitFor(() =>
      expect(
        within(screen.getByTestId("document-import-assist")).getByText(
          /已按补充说明更新草稿：新增 1 行：「截止：2026-10-30」/,
        ),
      ).toBeTruthy(),
    );
    expect(assistDocumentImport).toHaveBeenCalledTimes(1);
  });

  it("把整段说明重写说成改写，而不是同时新增和去掉同一句", async () => {
    const rewritten = WORKBENCH_DOCUMENT.replace(
      "- 当前说明：支持直接改数量",
      "- 当前说明：支持直接改数量，并在数量变化时即时刷新金额与小计。",
    );
    const { assistDocumentImport } = mount({
      directory: DIRECTORY,
      assist: { markdown: rewritten, model: "stub-model", issues: [] },
    });
    pasteDocument(WORKBENCH_DOCUMENT);

    sendSupplement("功能说明帮我写详细一点");

    await waitFor(() => {
      const messages = screen.getByTestId("document-import-assist-messages");
      expect(messages.textContent ?? "").toContain("改写 1 处");
      expect(messages.textContent ?? "").toContain("功能说明");
      expect(messages.textContent ?? "").not.toContain("新增 1 行");
      expect(messages.textContent ?? "").not.toContain("去掉 1 行");
    });
    expect(assistDocumentImport).toHaveBeenCalledTimes(1);
  });

  it("模型这一轮没改动草稿时明说「没有变化」，不再一片安静", async () => {
    const { assistDocumentImport } = mount({
      directory: DIRECTORY,
      // 模型原样返回当前草稿：用户此前只看到自己那句话，左边毫无反应。
      assist: { markdown: WORKBENCH_DOCUMENT, model: "stub-model", issues: [] },
    });
    pasteDocument(WORKBENCH_DOCUMENT);

    sendSupplement("帮我补充上陈昊");

    await waitFor(() =>
      expect(
        within(screen.getByTestId("document-import-assist")).getByText(
          /这一轮草稿没有变化/,
        ),
      ).toBeTruthy(),
    );
    expect(assistDocumentImport).toHaveBeenCalledTimes(1);
  });

  it("AI 未启用（503）时展示固定中文提示且入口不隐藏", async () => {
    const { assistDocumentImport } = mount({
      directory: DIRECTORY,
      assistError: new ApiError(503, {
        code: "AI_ASSIST_DISABLED",
        message: "disabled",
        details: {},
        requestId: "test",
      }),
    });
    pasteDocument(WORKBENCH_DOCUMENT);
    sendSupplement("需求文本");

    expect(
      await screen.findByText(
        "AI 辅助转换未启用或配置无效，请管理员在「成员与设置 → AI 辅助转换」中配置后重试。",
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("document-import-assist")).toBeTruthy();
    expect(screen.getByTestId("document-import-assist-run")).toBeTruthy();
    expect(assistDocumentImport).toHaveBeenCalledTimes(1);
  });

  it("目标项目、模块或功能失效时明确提示重新选择导入位置", async () => {
    mount({
      directory: DIRECTORY,
      assistError: new ApiError(404, {
        code: "DOCUMENT_IMPORT_TARGET_NOT_FOUND",
        message: "target missing",
        details: {},
        requestId: "test",
      }),
    });
    pasteDocument(WORKBENCH_DOCUMENT);
    sendSupplement("需求文本");

    expect(
      await screen.findByText(
        "导入位置不存在，或你已没有该项目的写权限，请重新选择后再试。",
      ),
    ).toBeTruthy();
  });

  it("普通 422 校验失败不再误报为文本超过 20 万字符", async () => {
    mount({
      directory: DIRECTORY,
      assistError: new ApiError(422, {
        code: "VALIDATION_FAILED",
        message: "请求字段校验失败",
        details: { issues: "target: Unrecognized key" },
        requestId: "test-422",
      }),
    });
    pasteDocument(WORKBENCH_DOCUMENT);
    sendSupplement("需求文本");

    expect(
      await screen.findByText(
        "AI 整理请求未通过校验，请检查导入位置和文档内容后重试；若持续失败，请联系管理员。",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/文本超过 20 万字符上限/)).toBeNull();
  });

  it("上游限流（503 + reason）时给出对应中文提示", async () => {
    mount({
      directory: DIRECTORY,
      assistError: new ApiError(503, {
        code: "AI_ASSIST_UPSTREAM_FAILED",
        message: "upstream",
        details: { reason: "rate-limited" },
        requestId: "test",
      }),
    });
    pasteDocument(WORKBENCH_DOCUMENT);
    sendSupplement("需求文本");

    expect(
      await screen.findByText("AI 服务请求过于频繁（上游限流），请稍后重试。"),
    ).toBeTruthy();
  });

  it("上游长度上限（503 + reason=context-limit）时给出可操作提示", async () => {
    mount({
      directory: DIRECTORY,
      assistError: new ApiError(503, {
        code: "AI_ASSIST_UPSTREAM_FAILED",
        message: "upstream",
        details: { reason: "context-limit" },
        requestId: "test",
      }),
    });
    pasteDocument(WORKBENCH_DOCUMENT);
    sendSupplement("需求文本");

    // 推理模型占满输出预算与「文档太长」走同一条提示：都要给出精简 / 调高上限的解法。
    expect(
      await screen.findByText(
        "文档超出模型长度上限，或模型推理占满了输出预算：请精简文档或分次生成，也可让管理员调高「最大输出 tokens」。",
      ),
    ).toBeTruthy();
  });

  it("发送时补充说明为空则不发请求", async () => {
    const { assistDocumentImport } = mount({ directory: DIRECTORY });
    pasteDocument(WORKBENCH_DOCUMENT);

    fireEvent.click(screen.getByTestId("document-import-assist-run"));

    expect(assistDocumentImport).not.toHaveBeenCalled();
  });

  it("长文档抽取警告展示为非阻断提示并继续分析", async () => {
    const { assistDocumentImport } = mount();
    extractDocumentTextMock.mockResolvedValue({
      fileName: "长文档.md",
      text: "很长的需求文本",
      warning:
        "文档较长（超过 10 万字符），模型上下文可能不足以完整分析，建议精简或分段生成。",
    });

    pickFile(new File(["x"], "长文档.md"));

    expect(
      await screen.findByText(
        "文档较长（超过 10 万字符），模型上下文可能不足以完整分析，建议精简或分段生成。",
      ),
    ).toBeTruthy();
    await waitFor(() =>
      expect(assistDocumentImport).toHaveBeenCalledWith({
        mode: "IN_PROJECT",
        target: { projectId: 2, moduleId: null, featureId: null },
        text: "很长的需求文本",
      }),
    );
  });

  it("普通成员看不到 AI 配置入口，管理员点击后跳到设置页 AI 页签", async () => {
    mount();
    expect(
      screen.queryByTestId("document-import-assist-settings"),
    ).not.toBeInTheDocument();
  });

  it("管理员点击「配置」跳到 /settings?tab=aiAssist", async () => {
    mount({ admin: true });
    fireEvent.click(screen.getByTestId("document-import-assist-settings"));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/settings?tab=aiAssist",
      ),
    );
  });
});

describe("文档导入：拖放与进行中反馈", () => {
  /** jsdom 没有 DataTransfer：手工造一个只带文件列表的事件，模拟真实拖放。 */
  function fireFileDrag(
    target: EventTarget,
    type: "dragover" | "drop",
    file: File,
  ): void {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { types: ["Files"], files: [file], dropEffect: "none" },
    });
    Object.defineProperty(event, "relatedTarget", { value: null });
    target.dispatchEvent(event);
  }

  it("已有草稿时把文件拖到左栏同样会读取并分析", async () => {
    const { assistDocumentImport } = mount({ directory: DIRECTORY });
    // 左栏已经有内容：空态那个拖入区已经收起，此前拖放就是石沉大海。
    pasteDocument(WORKBENCH_DOCUMENT);
    expect(screen.queryByTestId("document-import-assist-file")).toBeNull();

    // 自由正文：走「交给 AI 整理」那条真实链路（模板文档只会本地直读，不调模型）。
    extractDocumentTextMock.mockResolvedValue({
      fileName: "补充需求.pdf",
      text: "需求补充：售后要支持退货流程，负责人林雨。",
      warning: null,
    });
    const file = new File(["pdf-bytes"], "补充需求.pdf", {
      type: "application/pdf",
    });

    // 手工派发的事件不在 RTL 的 act 里：显式包一层，让状态更新立刻落到 DOM。
    const pane = screen.getByTestId("document-import-pane");
    act(() => {
      fireFileDrag(pane, "dragover", file);
    });
    const overlay = screen.getByTestId("document-import-drop-overlay");
    // 落点提示只挂在左栏内容区里（空态拖入区 / 草稿区），不再罩住整个工作台。
    expect(overlay.closest(".import-pane-body")).not.toBeNull();
    expect(overlay.closest(".import-assist")).toBeNull();
    expect(overlay.closest(".import-format-guide")).toBeNull();

    act(() => {
      fireFileDrag(pane, "drop", file);
    });
    expect(screen.queryByTestId("document-import-drop-overlay")).toBeNull();
    await waitFor(() =>
      expect(extractDocumentTextMock).toHaveBeenCalledWith(file),
    );
    await waitFor(() =>
      expect(assistDocumentImport).toHaveBeenCalledWith({
        mode: "IN_PROJECT",
        target: { projectId: 2, moduleId: null, featureId: null },
        text: "需求补充：售后要支持退货流程，负责人林雨。",
      }),
    );
  });

  it("松手在左栏之外不导入，只提示拖到左栏", async () => {
    const { assistDocumentImport } = mount({ directory: DIRECTORY });
    pasteDocument(WORKBENCH_DOCUMENT);
    const file = new File(["pdf-bytes"], "补充需求.pdf", {
      type: "application/pdf",
    });

    // 右栏 AI 助手：不在左栏的 drop 区域内。
    const assist = document.querySelector(".import-assist") as HTMLElement;
    act(() => {
      fireFileDrag(assist, "dragover", file);
    });
    expect(screen.queryByTestId("document-import-drop-overlay")).toBeNull();

    act(() => {
      fireFileDrag(assist, "drop", file);
    });
    expect(extractDocumentTextMock).not.toHaveBeenCalled();
    expect(assistDocumentImport).not.toHaveBeenCalled();
    expect(
      screen.getByText("请把文件拖到左栏「内容梳理」区域里再松手。"),
    ).toBeTruthy();
  });

  it("读取与整理期间右栏显示进行中提示，结束后消失", async () => {
    mount({ directory: DIRECTORY });
    let release: ((value: ExtractedDocumentText) => void) | undefined;
    extractDocumentTextMock.mockImplementation(
      () =>
        new Promise<ExtractedDocumentText>((resolve) => {
          release = resolve;
        }),
    );

    pickFile(new File(["pdf-bytes"], "需求.pdf", { type: "application/pdf" }));

    const busy = await screen.findByTestId("document-import-assist-busy");
    expect(busy.textContent).toContain("正在本地读取文档");

    release?.({
      fileName: "需求.pdf",
      text: "# 项目：商城系统\n- 项目编码：MALL",
      warning: null,
    });
    await waitFor(() =>
      expect(screen.queryByTestId("document-import-assist-busy")).toBeNull(),
    );
  });
});

describe("项目成员名单校验（整项目导入；ADR-073 起创建者默认算成员）", () => {
  const creatorUser: CurrentUserResponse = {
    id: 9,
    loginName: "tege",
    name: "特哥",
    email: null,
    avatarUrl: null,
    isAdmin: false,
    status: "ACTIVE",
  };
  /** 项目成员只写了一个同事，任务负责人另一个人：负责人没在名单里。 */
  const MEMBER_GAP_DOCUMENT = [
    "# 项目：商城结算系统",
    "- 项目编码：MALL",
    "- 项目成员：林雨",
    "## 模块：购物车",
    "### 功能：数量调整",
    "#### 任务：数量调整交互",
    "- 负责人：陈昊",
  ].join("\n");

  it("没写项目成员：报「缺项目成员」，助手按必填缺口报数", async () => {
    mount({
      mode: "NEW_PROJECT",
      user: creatorUser,
      directory: DIRECTORY,
    });
    pasteDocument(
      [
        "# 项目：商城结算系统",
        "- 项目编码：MALL",
        "## 模块：购物车",
        "### 功能：数量调整",
        "#### 任务：数量调整交互",
        "- 负责人：林雨",
      ].join("\n"),
    );

    const assist = screen.getByTestId("document-import-assist");
    expect(within(assist).getByText("缺项目成员 ×1")).toBeTruthy();
    expect(await within(assist).findByText(/必填还差 1 处/)).toBeTruthy();
  });

  it("名单缺任务负责人：只点这一条，不再报「项目成员缺创建者」", async () => {
    mount({
      mode: "NEW_PROJECT",
      user: creatorUser,
      directory: DIRECTORY,
    });
    pasteDocument(MEMBER_GAP_DOCUMENT);

    const assist = screen.getByTestId("document-import-assist");
    expect(within(assist).queryByText("项目成员缺创建者 ×1")).toBeNull();
    // 负责人那条要等成员目录回来才能判（判定依赖目录里的账号）。
    expect(
      await within(assist).findByText("项目成员缺任务负责人 ×1"),
    ).toBeTruthy();
  });

  it("名单写全负责人但不写创建者时不再报成员缺口（创建者默认就在里面）", async () => {
    mount({
      mode: "NEW_PROJECT",
      user: creatorUser,
      directory: DIRECTORY,
    });
    pasteDocument(
      [
        "# 项目：商城结算系统",
        "- 项目编码：MALL",
        "- 项目成员：林雨, 陈昊",
        "## 模块：购物车",
        "### 功能：数量调整",
        "#### 任务：数量调整交互",
        "- 负责人：陈昊",
      ].join("\n"),
    );

    const assist = screen.getByTestId("document-import-assist");
    // 落地汇报只在成员目录就绪后才发，等到它就说明判定已经拿到目录。
    expect(await within(assist).findByText(/已进入内容梳理/)).toBeTruthy();
    expect(within(assist).queryByText(/项目成员缺/)).toBeNull();
    expect(within(assist).queryByText("缺项目成员 ×1")).toBeNull();
  });

  it("任务负责人就是创建者本人时也不报缺负责人", async () => {
    mount({
      mode: "NEW_PROJECT",
      user: creatorUser,
      directory: DIRECTORY,
    });
    pasteDocument(
      [
        "# 项目：商城结算系统",
        "- 项目编码：MALL",
        "- 项目成员：林雨",
        "## 模块：购物车",
        "### 功能：数量调整",
        "#### 任务：数量调整交互",
        "- 负责人：林雨, 特哥",
      ].join("\n"),
    );

    const assist = screen.getByTestId("document-import-assist");
    expect(await within(assist).findByText(/已进入内容梳理/)).toBeTruthy();
    expect(within(assist).queryByText(/项目成员缺/)).toBeNull();
  });

  it("名单里写了登录名（本地读不懂）时不误报缺负责人", async () => {
    mount({
      mode: "NEW_PROJECT",
      user: creatorUser,
      directory: DIRECTORY,
    });
    pasteDocument(
      [
        "# 项目：商城结算系统",
        "- 项目编码：MALL",
        "- 项目成员：林雨, xiaowu",
        "## 模块：购物车",
        "### 功能：数量调整",
        "#### 任务：数量调整交互",
        "- 负责人：xiaowu",
      ].join("\n"),
    );

    const assist = screen.getByTestId("document-import-assist");
    expect(await within(assist).findByText(/已进入内容梳理/)).toBeTruthy();
    expect(within(assist).queryByText(/项目成员缺/)).toBeNull();
  });

  it("项目内导入不做这两项校验", async () => {
    mount({ mode: "PROJECT", user: creatorUser, directory: DIRECTORY });
    pasteDocument(
      [
        "## 模块：购物车",
        "### 功能：数量调整",
        "#### 任务：数量调整交互",
        "- 负责人：林雨",
      ].join("\n"),
    );

    const assist = screen.getByTestId("document-import-assist");
    expect(await within(assist).findByText(/已进入内容梳理/)).toBeTruthy();
    expect(within(assist).queryByText("缺项目成员 ×1")).toBeNull();
    expect(within(assist).queryByText(/项目成员缺/)).toBeNull();
  });
});

describe("创建者是固定成员（ADR-073，2026-10-14）", () => {
  const CREATOR: CurrentUserResponse = {
    id: 9,
    loginName: "linyuyan",
    name: "林雨妍",
    email: null,
    avatarUrl: null,
    isAdmin: false,
    status: "ACTIVE",
  };
  const CREATOR_DIRECTORY: readonly UserDirectoryItem[] = [
    {
      id: 1,
      name: "林雨",
      avatarUrl: null,
      isAdmin: false,
      organizations: [],
    },
    {
      id: 9,
      name: "林雨妍",
      avatarUrl: null,
      isAdmin: false,
      organizations: [],
    },
  ];
  const CREATOR_DOCUMENT = [
    "# 项目：商城结算系统",
    "- 项目编码：MALL",
    "- 项目成员：林雨",
    "## 模块：购物车",
    "- 说明：购物车增删改与价格试算",
    "### 功能：数量调整",
    "- 当前说明：支持直接改数量",
    "#### 任务：数量调整交互",
    "- 负责人：林雨",
  ].join("\n");

  /** 编辑中的标签行：每个标签的删除按钮带「移除 X」的 aria-label。 */
  function tagNames(): readonly string[] {
    return within(screen.getByTestId("document-import-member-editor"))
      .queryAllByRole("button")
      .map((item) =>
        (item.getAttribute("aria-label") ?? "").replace("移除 ", ""),
      );
  }

  it("项目成员行上挂着创建者的锁定标签，且正文一字不改", async () => {
    mount({ mode: "NEW_PROJECT", user: CREATOR, directory: CREATOR_DIRECTORY });
    pasteDocument(CREATOR_DOCUMENT);

    const lock = await screen.findByTestId("document-import-creator-lock");
    expect(lock.textContent).toBe("林雨妍");
    expect(lock.className).toContain("is-locked");
    // 固定：这枚标签没有删除按钮。
    expect(within(lock).queryByRole("button")).toBeNull();

    // 创建者只挂在字段上，不改文档正文：粘贴进来的「预览文档」仍是原版。
    expect(importTextarea().value).toBe(CREATOR_DOCUMENT);
  });

  it("点开项目成员编辑时，创建者不是可删的标签，锁定标签仍在", async () => {
    mount({ mode: "NEW_PROJECT", user: CREATOR, directory: CREATOR_DIRECTORY });
    pasteDocument(CREATOR_DOCUMENT);
    await screen.findByTestId("document-import-creator-lock");

    fireEvent.click(screen.getByRole("button", { name: "项目：项目成员" }));
    expect(tagNames()).toEqual(["林雨"]);
    expect(screen.queryByRole("button", { name: "移除 林雨妍" })).toBeNull();
    expect(screen.getByTestId("document-import-creator-lock")).toBeTruthy();
  });

  it("名单里已经写了创建者本人就不再重复挂锁定标签（按姓名认）", async () => {
    mount({ mode: "NEW_PROJECT", user: CREATOR, directory: CREATOR_DIRECTORY });
    pasteDocument(
      CREATOR_DOCUMENT.replace("- 项目成员：林雨", "- 项目成员：林雨妍、林雨"),
    );
    await screen.findByText("林雨妍、林雨");

    expect(screen.queryByTestId("document-import-creator-lock")).toBeNull();
  });

  it("名单里写的是创建者登录名也不重复挂（按登录名认）", async () => {
    mount({ mode: "NEW_PROJECT", user: CREATOR, directory: CREATOR_DIRECTORY });
    pasteDocument(
      CREATOR_DOCUMENT.replace("- 项目成员：林雨", "- 项目成员：linyuyan"),
    );
    await screen.findByText("linyuyan");

    expect(screen.queryByTestId("document-import-creator-lock")).toBeNull();
  });
  it("项目内导入（模式 A）不挂创建者标签：那边成员不由文档决定", async () => {
    mount({ user: CREATOR, directory: CREATOR_DIRECTORY });
    pasteDocument(CREATOR_DOCUMENT);
    await screen.findByTestId("document-import-draft");

    expect(screen.queryByTestId("document-import-creator-lock")).toBeNull();
  });
});
describe("成员字段的账号搜索建议（2026-10-14）", () => {
  const MEMBER_DIRECTORY: readonly UserDirectoryItem[] = [
    {
      id: 1,
      name: "林雨",
      avatarUrl: null,
      isAdmin: false,
      organizations: [],
    },
    {
      id: 2,
      name: "小潘",
      avatarUrl: null,
      isAdmin: false,
      organizations: [],
    },
    {
      id: 3,
      name: "小邵",
      avatarUrl: null,
      isAdmin: true,
      organizations: [],
    },
    {
      id: 4,
      name: "王小二",
      avatarUrl: null,
      isAdmin: false,
      organizations: [],
    },
    // 文档里「项目成员」本就写着陈昊：目录里也有他，点开就只是一个标签，不再出现在候选里。
    {
      id: 5,
      name: "陈昊",
      avatarUrl: null,
      isAdmin: false,
      organizations: [],
    },
  ];

  /**
   * 建议按成员目录筛，而目录是异步来的；点字段之前先等它回来。「名字对不上」那块只有拿到
   * 目录后才渲染（目录为空 / 还在路上时一律不判定，见 assigneeChecked）。
   */
  async function waitForDirectory(): Promise<void> {
    await screen.findByTestId("document-import-unmatched");
  }

  function editor(label: string): HTMLInputElement {
    return screen.getByLabelText(label) as HTMLInputElement;
  }

  function suggestList(): HTMLElement {
    return screen.getByTestId("document-import-member-suggest");
  }

  /** 编辑中的标签行：每个标签的删除按钮带「移除 X」的 aria-label。 */
  function tagNames(): readonly string[] {
    return (
      within(screen.getByTestId("document-import-member-editor"))
        // queryAll：标签都被摘掉时这里就是空的，用 getAll 会直接抛错。
        .queryAllByRole("button")
        .map((item) =>
          (item.getAttribute("aria-label") ?? "").replace("移除 ", ""),
        )
    );
  }

  function suggestionNames(): readonly (string | null | undefined)[] {
    return within(suggestList())
      .getAllByRole("button")
      .map(
        (item) =>
          item.querySelector(".import-member-suggest-name")?.textContent,
      );
  }

  it("项目成员：已写定的名字各是一个标签，候选列表一直挂着可以接着挑下一个", async () => {
    mount({ directory: MEMBER_DIRECTORY });
    pasteDocument(WORKBENCH_DOCUMENT);
    await waitForDirectory();

    fireEvent.click(screen.getByRole("button", { name: "项目：项目成员" }));
    // 「林雨、陈昊」直接拆成两个标签；输入框只装正在输入的那一段（此刻是空的）。
    expect(tagNames()).toEqual(["林雨", "陈昊"]);
    expect(editor("项目：项目成员").value).toBe("");

    // 目录里剩下的人全在候选里：不用先猜一个字。
    await screen.findByTestId("document-import-member-suggest");
    expect(suggestionNames()).toEqual(["小潘", "小邵", "王小二"]);

    // 打一个字就筛；管理员多一个标记（与「指派给」下拉同款）。
    fireEvent.change(editor("项目：项目成员"), { target: { value: "小" } });
    expect(suggestionNames()).toEqual(["小潘", "小邵", "王小二"]);
    const second = within(suggestList()).getAllByRole(
      "button",
    )[1] as HTMLElement;
    expect(within(second).getByText("管理员")).toBeTruthy();

    // 点一条 → 多一个标签、输入框清空，候选列表仍在（这是本次要改的重点）。
    fireEvent.click(
      within(suggestList()).getByRole("button", { name: "小潘" }),
    );
    expect(tagNames()).toEqual(["林雨", "陈昊", "小潘"]);
    expect(editor("项目：项目成员").value).toBe("");
    expect(suggestList()).toBeTruthy();
    // 加过的人不再出现在候选里，剩下的还挂着，可以接着点下一个。
    expect(suggestionNames()).toEqual(["小邵", "王小二"]);

    fireEvent.keyDown(editor("项目：项目成员"), { key: "Enter" });
    expect(importTextarea().value).toContain("- 项目成员：林雨、陈昊、小潘");
  });

  it("任务负责人同样按标签挑：摘掉对不上的人，点候选写回负责人行", async () => {
    mount({ directory: MEMBER_DIRECTORY });
    pasteDocument(WORKBENCH_DOCUMENT);
    await waitForDirectory();

    fireEvent.click(
      screen.getByRole("button", { name: "数量调整接口联调：负责人" }),
    );
    // 「林语」对不上账号：先摘掉这个标签，再从候选里挑人。
    fireEvent.click(screen.getByRole("button", { name: "移除 林语" }));
    expect(tagNames()).toEqual([]);

    fireEvent.change(editor("数量调整接口联调：负责人"), {
      target: { value: "小" },
    });
    fireEvent.click(
      within(suggestList()).getByRole("button", { name: "小潘" }),
    );
    fireEvent.keyDown(editor("数量调整接口联调：负责人"), { key: "Enter" });

    expect(importTextarea().value).toContain("- 负责人：小潘");
    expect(importTextarea().value).not.toContain("林语");
  });

  it("中文输入法组合期间按回车不提交，真正的回车才提交", async () => {
    mount({ directory: MEMBER_DIRECTORY });
    pasteDocument(WORKBENCH_DOCUMENT);
    await waitForDirectory();

    fireEvent.click(screen.getByRole("button", { name: "项目：项目成员" }));
    fireEvent.change(editor("项目：项目成员"), { target: { value: "小" } });
    // 组合中的回车是「确认候选字」，不是「提交这一格」。
    fireEvent.keyDown(editor("项目：项目成员"), {
      key: "Enter",
      isComposing: true,
    });
    expect(screen.getByTestId("document-import-member-editor")).toBeTruthy();
    expect(importTextarea().value).toContain("- 项目成员：林雨、陈昊");

    fireEvent.keyDown(editor("项目：项目成员"), { key: "Enter" });
    expect(importTextarea().value).toContain("- 项目成员：林雨、陈昊、小");
  });

  it("只有成员字段给建议：项目编码打字不出候选", async () => {
    mount({ directory: MEMBER_DIRECTORY });
    pasteDocument(WORKBENCH_DOCUMENT);
    await waitForDirectory();

    // 先在成员字段上确认这次挂载确实能出建议，免得下面的空断言只是因为目录没回来。
    fireEvent.click(screen.getByRole("button", { name: "项目：项目成员" }));
    expect(
      await screen.findByTestId("document-import-member-suggest"),
    ).toBeTruthy();
    fireEvent.keyDown(editor("项目：项目成员"), { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "项目：项目编码" }));
    fireEvent.change(screen.getByLabelText("项目：项目编码"), {
      target: { value: "小林" },
    });
    expect(screen.queryByTestId("document-import-member-suggest")).toBeNull();
  });
});
