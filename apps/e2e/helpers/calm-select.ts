import { expect, type Locator, type Page } from "@playwright/test";

/**
 * CalmSelect（antd Select）交互辅助。
 *
 * 触发器是 `div.ant-select`（内部 input 带 aria-label），弹层通过 portal 挂到
 * body 上。选项必须按当前下拉的 listbox 精确定位：刚关闭的弹层在退出动画期间
 * 仍是 `:visible`，全局查选项会命中旧弹层里的隐藏项而永久卡住。
 * 选项 title 即 CalmSelect 的 option label：字符串精确匹配，版本号这类含
 * 动态时间的用正则。
 *
 * 服务端搜索的下拉（如合并弹窗的「主任务」，远端要按编号/标题检索、最小长度 2）
 * 需要先输入关键词再等候选返回：给 `pickCalmSelectOption` 传第 4 个参数 `query` 即可，
 * 它在点开触发器后、读取 `aria-controls` 前先把关键词敲进去。
 */

function pageOf(scope: Page | Locator): Page {
  const candidate = scope as Locator;
  return typeof candidate.page === "function"
    ? candidate.page()
    : (scope as Page);
}

/**
 * 带 aria-label 的 antd Select 根节点（其文本即当前选中项）。
 * 触发器由输入框的 `.ant-select` 祖先定位：在弹窗作用域下 filter({ has })
 * 不会跨根重定位内层定位器，祖先轴是唯一在两个作用域都稳定的写法。
 */
export function calmSelectTrigger(
  scope: Page | Locator,
  label: string,
): Locator {
  return scope
    .getByLabel(label)
    .first()
    .locator(
      'xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]',
    );
}

/** 打开指定下拉并断言弹层向触发器下方展开，随后收起。 */
export async function expectCalmSelectOpensBelow(
  scope: Page | Locator,
  label: string,
): Promise<void> {
  const page = pageOf(scope);
  const trigger = calmSelectTrigger(scope, label);
  const triggerBox = await trigger.boundingBox();
  if (!triggerBox) throw new Error("calm select trigger is not laid out");
  await trigger.click();
  const dropdown = page.locator(".ant-select-dropdown:visible").last();
  await expect(dropdown).toBeVisible();
  const dropdownBox = await dropdown.boundingBox();
  if (!dropdownBox) throw new Error("calm select dropdown is not laid out");
  expect(dropdownBox.y).toBeGreaterThanOrEqual(
    triggerBox.y + triggerBox.height,
  );
  await outsideOf(scope).dispatchEvent("mousedown");
  await expect(dropdown).toBeHidden();
}

/** 打开下拉并返回该触发器自己的 listbox（用 aria-controls 精确匹配）。 */
async function openListbox(
  scope: Page | Locator,
  label: string,
  query?: string,
): Promise<Locator> {
  const page = pageOf(scope);
  const input = scope.getByLabel(label).first();
  await calmSelectTrigger(scope, label).click();
  if (query !== undefined) await input.fill(query);
  // 填入关键词后输入框被重渲染（rc-select 受控搜索值），必须重新取一次 aria-controls。
  const listId = await input.getAttribute("aria-controls");
  const listbox =
    listId === null || listId === ""
      ? page.locator('.ant-select-dropdown:visible [role="listbox"]').last()
      : page.locator('[role="listbox"][id="' + listId + '"]');
  await expect(listbox).toBeVisible();
  return listbox;
}

/**
 * 点开 CalmSelect 并选择目标选项（按选项 title 匹配）。
 *
 * `query`：服务端搜索的下拉专用，关键词会先写进触发器；候选由远端返回，
 * 所以调用方要保证关键词已能命中目标项（通常直接用选项标题本身）。
 *
 * 单选下拉选中后会自动收起，但同一个辅助也用于多选下拉（如任务弹窗的「指派给」）：
 * 多选弹层选中后仍停留在原地，并向下覆盖「优先级」等后续字段，下一次点击会被弹层的
 * 选项行判为「拦截 pointer events」而一直重试到超时。这里沿用多选版的同一口径：选中
 * 后若弹层仍未收起，就把 mousedown 直接派发到作用域本身（必然在触发器之外）显式收起。
 */
export async function pickCalmSelectOption(
  scope: Page | Locator,
  label: string,
  option: string | RegExp,
  query?: string,
): Promise<void> {
  const listbox = await openListbox(scope, label, query);
  const item =
    typeof option === "string"
      ? listbox.getByTitle(option, { exact: true })
      : listbox.getByTitle(option);
  await item.first().click();
  if (await listbox.isVisible()) {
    await outsideOf(scope).dispatchEvent("mousedown");
    await expect(listbox).toBeHidden();
  }
}

/**
 * 按下标点选（等价旧 selectOption({ index })）。下标以真实渲染的选项为准：多数下拉会把
 * 「请选择…」占位项一并渲染成禁用的第一项，而记录草稿编辑器的「所属模块」没有占位项，
 * index 0 就是第一个真实模块。
 */
export async function pickCalmSelectOptionByIndex(
  scope: Page | Locator,
  label: string,
  index: number,
): Promise<void> {
  const listbox = await openListbox(scope, label);
  await listbox.locator(".ant-select-item-option").nth(index).click();
}

/**
 * 选中下拉里的第一个选项，用于「选任意一个归属模块」这类不关心具体取值的步骤。
 * 不要把这种语义写成固定下标：没有占位项的下拉里 index 1 直接不存在，而 Playwright 的
 * actionTimeout 默认为 0（不超时），用例会一直卡到整体超时。
 */
export async function pickFirstCalmSelectOption(
  scope: Page | Locator,
  label: string,
): Promise<void> {
  await pickCalmSelectOptionByIndex(scope, label, 0);
}

/**
 * 作用域自身的元素（页面作用域兜底到 body），用于必要时派发「选择器之外」的事件。
 * `first()` 是因为 antd Modal 的外壳与 AppModal 的盒子都带 `role="dialog"`：
 * 按 `role` 抓到的作用域通常是两个元素，派发事件本身要求唯一定位。
 */
function outsideOf(scope: Page | Locator): Locator {
  return typeof (scope as Locator).page === "function"
    ? (scope as Locator).first()
    : (scope as Page).locator("body");
}

/**
 * 多选（`multiple`）：点开下拉后依次点选多个选项。多选弹层不会在每次选择后收起，
 * 选项支持重复点击取消，所以收尾要显式收起弹层；键盘收尾都不行：Esc 被 AppModal
 * 在捕获阶段接管「只关栈顶弹层」，会连带关掉整个弹窗，Tab 则会把焦点落进弹层自身，
 * 被 rc-select 的 `cancelFun` 判定为「仍在选择器内」而取消收起。
 * 收起动作也不能用真实点击：弹层会按空间向上翻转，覆盖弹窗标题等候选落点，真实点击
 * 会被 Playwright 的命中检测判为「被选项行拦截 pointer events」而一直重试到超时。
 * 因此改为把 mousedown 直接派发到作用域本身（弹窗盒子，必然在触发器之外）：rc-select
 * 的 `useSelectTriggerControl` 收到选择器之外的 mousedown 就会收起弹层；AppModal 只在
 * `event.target` 是盒子自身时关闭的那套逻辑走的是 click，不受影响。
 */
export async function pickCalmSelectOptions(
  scope: Page | Locator,
  label: string,
  options: readonly (string | RegExp)[],
): Promise<void> {
  const listbox = await openListbox(scope, label);
  for (const option of options) {
    const item =
      typeof option === "string"
        ? listbox.getByTitle(option, { exact: true })
        : listbox.getByTitle(option);
    await item.first().click();
  }
  await outsideOf(scope).dispatchEvent("mousedown");
  await expect(listbox).toBeHidden();
}
