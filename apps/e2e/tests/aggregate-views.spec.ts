import { expect, test } from "@playwright/test";

import { createAuthenticatedContext } from "../helpers/auth-context.js";
import { loadRuntime } from "../helpers/runtime.js";
import {
  calmSelectTrigger,
  pickCalmSelectOption,
} from "../helpers/calm-select.js";
import {
  createTaskInOpenModule,
  openFirstModuleTasks,
} from "../helpers/module-tasks.js";

/**
 * F-29 项目主页（概览已并入模块与任务）/ F-32 任务中心的专属关键路径 E2E。
 * 两个页面默认注入服务端适配器（R-2 / R-3）：这里验证真实服务端数据进入
 * 视图（工具栏工作状态筛选、优先级筛选、遗留问题总数与优先级徽章）、仍无契约
 * 来源的条件按显式降级处理（关键词搜索只对已加载页生效并标注，「我创建的」经
 * ownership 参数接入服务端），
 * 以及 F-30 约定下筛选状态由 URL 承载。
 */

test("F-32 任务中心：真实任务进入列表，工作状态与优先级接线，筛选状态写入 URL", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);
  // 侧栏任务徽章会静默请求 /api/v1/me/tasks；它 500 时页面仍可用，因此必须显式收集，
  // 不能让「列表可见」掩盖契约违约（2026-10-20 游标超过 256 的实际回归）。
  const shellTaskFailures: string[] = [];
  page.on("response", (response) => {
    if (
      new URL(response.url()).pathname === "/api/v1/me/tasks" &&
      response.status() >= 500
    ) {
      shellTaskFailures.push(String(response.status()));
    }
  });
  try {
    const suffix = Date.now().toString(16).toUpperCase();
    const taskTitle = "聚合读任务-" + suffix;

    await openFirstModuleTasks(page, runtime.projectId);
    await createTaskInOpenModule(page, runtime.user.name, taskTitle);

    await page.goto("/tasks");
    const center = page.getByTestId("task-center");
    await expect(center).toBeVisible();

    const notice = page.getByTestId("task-center-mock-notice");
    // 设计师稿 task-center.tsx 没有「接口说明」黄条：默认服务端适配器下页面只呈现
    // 工具栏筛选与任务列表，骨架数据提示只在 mock 降级时出现。
    await expect(notice).toHaveCount(0);

    // 2026-09-21 定案：逾期风险条与四张统计卡（今日待办 / 未完成 / 已完成 / 我创建的）
    // 整体删除，工作状态改由工具栏分段控件承担（缺省落在「未完成」）。
    await expect(page.locator(".stats-grid")).toHaveCount(0);
    await expect(page.locator(".risk-strip")).toHaveCount(0);
    await expect(page.getByTestId("stat-my-open")).toHaveCount(0);
    await expect(page.getByTestId("stat-created")).toHaveCount(0);

    const statusFilter = page.getByRole("group", { name: "工作状态" });
    await expect(
      statusFilter.getByRole("button", { name: "未完成" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      statusFilter.getByRole("button", { name: "已完成" }),
    ).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByLabel("搜索任务")).toBeEnabled();
    await expect(page.getByLabel("优先级")).toBeEnabled();
    // 范围分段行已移除：工具栏常驻项目筛选（默认「全部项目」），与遗留问题页同口径；
    // 2026-09-20 起去掉与下拉内容重复的「项目」文字标签，改为直接断言下拉本身。
    await expect(calmSelectTrigger(page, "项目")).toContainText("全部项目");

    // 缺省口径是「全部未完成任务」（不再默认收窄到今日待办）：URL 不写 today 参数，
    // 刚创建的任务没有截止时间，也必须直接出现在卡片列表里。
    await expect
      .poll(() => new URL(page.url()).searchParams.get("today"))
      .toBeNull();

    const taskCard = page
      .locator(".calm-task-card")
      .filter({ hasText: taskTitle });
    await expect(taskCard).toBeVisible();
    await expect(taskCard).toContainText(runtime.user.name);
    await expect(taskCard.locator('[title="优先级：普通"]')).toHaveText("普通");
    await expect(taskCard).toContainText("未设置截止");

    // 产品要求（2026-09-21）：标题「任务中心」到筛选行的距离，必须和筛选行到卡片的
    // 距离一致。h1 行高 40.5px 而表意文字只占 27px，上下各有 6.75px 半行距，所以
    // 比较的是标题可见墨迹的底边，不能直接拿 h1 行盒底边（那会少算半行距）。
    const headerSpacing = await page.evaluate(() => {
      const rect = (selector: string) => {
        const element = document.querySelector(selector);
        if (element === null) {
          throw new Error("任务中心缺少元素：" + selector);
        }
        return element.getBoundingClientRect();
      };
      const title = document.querySelector(".task-center .page-header h1");
      if (title === null) {
        throw new Error("任务中心缺少标题");
      }
      const styles = getComputedStyle(title);
      const halfLeading =
        (Number.parseFloat(styles.lineHeight) -
          Number.parseFloat(styles.fontSize)) /
        2;
      const inkBottom =
        title.getBoundingClientRect().top +
        halfLeading +
        Number.parseFloat(styles.fontSize);
      const toolbar = rect(".task-toolbar");
      return {
        titleToToolbar: toolbar.top - inkBottom,
        toolbarToCards: rect(".calm-task-grid").top - toolbar.bottom,
      };
    });
    expect(headerSpacing.titleToToolbar).toBeGreaterThan(0);
    expect(
      Math.abs(headerSpacing.titleToToolbar - headerSpacing.toolbarToCards),
    ).toBeLessThanOrEqual(4);
    // 2026-09-22 定案：卡片网格在窗口拉到最大时一行四张（内容区 1420px 上限与 236px
    // 侧栏决定四列就是宽屏上限），分界宽度 1440px；再窄一档回到三张。
    const gridColumnCount = () =>
      page.evaluate(() => {
        const grid = document.querySelector(".calm-task-grid");
        if (grid === null) {
          throw new Error("任务中心缺少卡片网格");
        }
        return getComputedStyle(grid).gridTemplateColumns.split(" ").length;
      });
    await page.setViewportSize({ width: 1439, height: 900 });
    await expect.poll(gridColumnCount).toBe(3);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(gridColumnCount).toBe(4);
    await page.setViewportSize({ width: 1680, height: 900 });
    await expect.poll(gridColumnCount).toBe(4);
    // 后续断言沿用 Desktop Chrome 的缺省视口。
    await page.setViewportSize({ width: 1280, height: 720 });

    // 「我创建的」卡片入口已删除，但 R-3 的 ownership 参数仍然生效：按 URL 直接打开
    // scope=created 时，任务中心请求必须携带 scope=created，且这次由当前用户创建的任务
    // （创建者=当前用户）仍在列表里。
    const createdRequest = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === "/api/v1/tasks" &&
        new URL(request.url()).searchParams.get("scope") === "created",
    );
    await page.goto("/tasks?scope=created");
    await createdRequest;
    await expect(page.getByTestId("task-center")).toBeVisible();
    await expect(
      page.locator(".calm-task-card").filter({ hasText: taskTitle }),
    ).toBeVisible();

    // 回到缺省「全部未完成」视图：scope 参数不再写入 URL（F-30 省略默认值）。
    await page.goto("/tasks");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("scope"))
      .toBeNull();
    await expect(taskCard).toBeVisible();

    // 工具栏项目筛选（替代原「按项目」范围）：选中 fixture 项目后写入 project
    // 参数、任务仍在列表里；回到「全部项目」后参数被移除。
    await pickCalmSelectOption(page, "项目", runtime.projectName);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("project"))
      .toBe(String(runtime.projectId));
    await expect(taskCard).toBeVisible();
    await pickCalmSelectOption(page, "项目", "全部项目");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("project"))
      .toBeNull();

    // 关键词搜索、合并关系与 GitHub 关联没有服务端参数，但可在已加载页上本地筛选：
    // 控件保持可用，同时出现显式范围提示，不能把本地结果说成服务端收敛。
    await expect(page.getByTestId("task-center-local-note")).toHaveCount(0);
    await page.getByLabel("搜索任务").fill(taskTitle);
    const localNote = page.getByTestId("task-center-local-note");
    await expect(localNote).toContainText("本地筛选");
    await expect(localNote).toContainText("服务端暂未提供参数");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("q"))
      .toBe(taskTitle);
    await expect(taskCard).toBeVisible();
    await page.getByLabel("搜索任务").fill("无匹配任务的关键词-zzz");
    await expect(taskCard).toHaveCount(0);
    await page.getByLabel("搜索任务").fill("");
    await expect(taskCard).toBeVisible();
    await expect(page.getByTestId("task-center-local-note")).toHaveCount(0);

    // 优先级筛选已接入服务端：选中写入 URL，清除后 URL 不再携带。
    await pickCalmSelectOption(page, "优先级", "高");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("priority"))
      .toBe("HIGH");
    await pickCalmSelectOption(page, "优先级", "全部优先级");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("priority"))
      .toBeNull();

    // F-30：筛选状态由 URL 承载，工作状态由工具栏「未完成 / 已完成」筛选设定。
    await statusFilter.getByRole("button", { name: "已完成" }).click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("status"))
      .toBe("done");
    // 列表区块标题行与「n 项 · 排序」说明已按产品要求删除：工作状态只由工具栏筛选表达，
    // 切到「已完成」后既没有残留标题，也不能再出现任何「未完成」措辞。
    await expect(
      statusFilter.getByRole("button", { name: "已完成" }),
    ).toHaveAttribute("aria-pressed", "true");
    // 2026-10-08：区块内的展示方式图标（.task-list-mark）与工具栏「卡片 / 列表」
    // 切换完全重复，已按用户指示删除；工作状态与展示方式都只由工具栏表达。
    await expect(page.locator(".task-list-mark")).toHaveCount(0);
    await expect(page.getByText("没有匹配的未完成任务")).toHaveCount(0);
    await page
      .getByRole("group", { name: "展示方式" })
      .getByRole("button", { name: "列表" })
      .click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("view"))
      .toBe("list");
    // 设计系统刻意把「更多筛选」触发按钮定为常驻 display:none：设计师稿的
    // design-system.css 与自带的视觉状态脚本（apps/e2e/scripts/visual-states.mjs）
    // 都按此约定，用 DOM 事件而不是可见点击展开筛选面板。这里沿用同一手法，
    // 断言（more=1 写入 URL、面板内容与可用性）保持不变。
    await page
      .locator(".task-toolbar > .secondary-button")
      .dispatchEvent("click");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("more"))
      .toBe("1");
    await expect(
      page.getByText("显示已取消任务（不计入完成率）"),
    ).toBeVisible();
    await expect(
      page.getByLabel("显示已取消任务（不计入完成率）"),
    ).toBeEnabled();

    // 任务中心不再跳转：重新进入 /tasks（卡片视图）后点击卡片，在当前页面就地
    // 弹出模块任务同款的任务详情弹窗，写操作（编辑 / 完成任务 / 合并 / 关联链接）
    // 仍只有这一个入口；地址栏与筛选参数保持不变，关闭后仍停留在任务中心。
    // 重新进任务中心：缺省即「全部未完成」，本用例的任务（没有截止时间）直接可见，
    // 不再需要 today=0 这类旧参数。
    await page.goto("/tasks");
    await expect(page.getByTestId("task-center")).toBeVisible();
    const navCard = page
      .locator(".calm-task-card")
      .filter({ hasText: taskTitle });
    await expect(navCard).toBeVisible();
    const taskCenterUrl = page.url();
    await navCard.click();
    const archiveDetail = page.getByRole("dialog", { name: "任务详情" });
    await expect(archiveDetail).toBeVisible();
    await expect(archiveDetail.getByText(taskTitle)).toBeVisible();
    await expect(
      archiveDetail.getByRole("button", { name: "编辑任务" }),
    ).toBeVisible();
    await expect(
      archiveDetail.getByRole("button", { name: "完成任务" }),
    ).toBeVisible();
    expect(page.url()).toBe(taskCenterUrl);
    await archiveDetail.getByRole("button", { name: "关闭" }).click();
    await expect(archiveDetail).toBeHidden();
    expect(page.url()).toBe(taskCenterUrl);
    await expect(page.getByTestId("task-center")).toBeVisible();

    // 遗留问题入口与任务卡片同一口径：就地弹出 F-20 视图（项目筛选跟随任务中心
    // 当前筛选），不跳转 `/issues`，地址栏保持不变，关闭后仍停在任务中心。
    await page.goto("/tasks");
    await expect(page.getByTestId("task-center")).toBeVisible();
    const issuesEntryUrl = page.url();
    await page
      .getByTestId("task-center")
      .getByRole("button", { name: "遗留问题" })
      .click();
    const issuesDialog = page.getByRole("dialog", { name: "遗留问题" });
    await expect(issuesDialog).toBeVisible();
    await expect(issuesDialog.getByTestId("issues-page")).toBeVisible();
    expect(page.url()).toBe(issuesEntryUrl);
    await issuesDialog.getByRole("button", { name: "关闭遗留问题" }).click();
    await expect(issuesDialog).toBeHidden();
    expect(page.url()).toBe(issuesEntryUrl);
    await expect(page.getByTestId("task-center")).toBeVisible();
    expect(shellTaskFailures).toEqual([]);
  } finally {
    await context.close();
  }
});

test("F-29 项目主页：服务端真实指标（含遗留问题总数）与入口导航", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    await page.goto("/projects/" + runtime.projectId + "/overview");
    const overview = page.getByTestId("project-overview");
    await expect(overview).toBeVisible();
    await expect(
      overview.getByRole("heading", { name: runtime.projectName }),
    ).toBeVisible();

    const notice = page.getByTestId("project-overview-mock-notice");
    // 设计师稿 catalog.tsx 的项目详情页没有「接口说明」黄条：服务端适配器下
    // 页面只呈现头部、指标条与两个面板，骨架数据提示只在 mock 降级时出现。
    await expect(notice).toHaveCount(0);

    // 指标卡按用户确认的口径只展示任务/记录/成员/遗留四项：
    // 「活跃模块」「活跃功能」已从展示层取消，功能统计已从服务端契约移除。
    await expect(page.getByTestId("overview-metric-modules")).toHaveCount(0);
    await expect(page.getByTestId("overview-metric-features")).toHaveCount(0);

    // 服务端指标异步加载：轮询等待真实值渲染完成，避免读到初始占位。
    // 成员数是 fixture 项目必然 > 0 的服务端真实值（创建者自动成为成员）。
    // 2026-10-08：成员卡不再带单位后缀「 人」，四张卡统一为裸数字，因此改用
    // 「解析出的整数 > 0」作为真实值证据（不再以「 人」后缀佐证）。
    const memberCount = page
      .getByTestId("overview-metric-members")
      .locator("strong");
    await expect
      .poll(async () =>
        Number.parseInt((await memberCount.textContent()) ?? "", 10),
      )
      .toBeGreaterThan(0);
    // 四张指标卡都以数字形态渲染（fixture 项目尚无已发布记录与遗留问题，值为 0）。
    for (const key of ["tasks", "records", "members", "leftovers"]) {
      const metric = page
        .getByTestId("overview-metric-" + key)
        .locator("strong");
      await expect
        .poll(async () =>
          /^\d+$/.test((await metric.textContent())?.trim() ?? ""),
        )
        .toBe(true);
    }

    await expect(page.getByRole("heading", { name: "最近迭代" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "待处理遗留问题" }),
    ).toBeVisible();
    await expect(page.getByText("暂无已发布记录")).toBeVisible();
    await expect(page.getByText("没有未处理的遗留问题")).toBeVisible();

    // 2026-09-20：项目主页三个入口改为就地弹窗——「查看全部」打开迭代记录
    // 弹窗，地址栏保持在项目主页；弹窗内项目筛选已预置为当前项目。
    await page.getByRole("button", { name: "查看全部" }).click();
    const recordsModal = page.getByRole("dialog", { name: "迭代记录" });
    await expect(recordsModal).toBeVisible();
    await expect(recordsModal).toContainText("迭代记录");
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toBe("/projects/" + runtime.projectId + "/modules");
    await recordsModal.getByRole("button", { name: "关闭迭代记录" }).click();
    await expect(recordsModal).toBeHidden();

    // 项目概览已与「模块与任务」合并：旧地址整体重定向到项目主页，
    // 重定向后仍是同一套项目头部 + 指标 + 面板。
    await page.goto("/projects/" + runtime.projectId + "/overview");
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toBe("/projects/" + runtime.projectId + "/modules");
    await expect(page.getByTestId("project-overview")).toBeVisible();

    // 2026-09-19：项目头部的「全部项目」返回入口已按用户要求移除，
    // 返回项目列表改由公共侧栏「项目列表」承担，这里不再断言该按钮。
  } finally {
    await context.close();
  }
});
