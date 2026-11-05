import type { NavigateFunction, NavigateOptions } from "react-router-dom";

import { preloadRoutePath } from "./route-preload";

export interface PreparedNavigationOptions extends NavigateOptions {
  /** 目标页首屏数据；失败不阻断导航。 */
  readonly prepare?: (() => Promise<unknown> | undefined) | undefined;
}

/**
 * 等目标页 chunk（以及可选首屏数据）就绪后再导航。
 * 预取失败只吞掉异常，导航仍会发生，避免网络抖动把用户困在当前页。
 */
export function navigatePrepared(
  navigate: NavigateFunction,
  path: string,
  options: PreparedNavigationOptions = {},
): Promise<void> {
  const { prepare, ...navigateOptions } = options;
  let data: Promise<unknown> | undefined;
  try {
    data = prepare?.();
  } catch {
    // 同步抛错与 Promise 拒绝同口径：预取失败不能把用户困在当前页。
    data = undefined;
  }
  return Promise.all([
    preloadRoutePath(path),
    Promise.resolve(data).catch(() => undefined),
  ]).then(() => {
    navigate(path, navigateOptions);
  });
}
