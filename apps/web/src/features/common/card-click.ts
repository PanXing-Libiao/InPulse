import type React from "react";

/**
 * 卡片整块可点击时，卡片内部往往还有链接和按钮（查看详情、编辑模块等）。
 * 判断这次点击是否是「点卡片本身」：左键、无修饰键、且落点不在卡片内的
 * 其他交互控件上，避免和内部控件抢事件。
 */
const INTERACTIVE_SELECTOR =
  "a[href], button, summary, input, textarea, select, label";

export const isCardClick = (event: React.MouseEvent<HTMLElement>): boolean => {
  if (event.defaultPrevented) return false;
  if (event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }
  const target = event.target as HTMLElement | null;
  if (!target) return false;
  // 弹层等 React portal 的 DOM 在 body 上，但合成事件仍沿 React 树冒泡到卡片。
  // 这类事件的目标节点在卡片之外，必须当作「卡片外部点击」，否则关闭弹层会误触发跳转。
  if (!event.currentTarget.contains(target)) return false;
  const nested = target.closest?.(INTERACTIVE_SELECTOR) ?? null;
  return nested === null || nested === event.currentTarget;
};
