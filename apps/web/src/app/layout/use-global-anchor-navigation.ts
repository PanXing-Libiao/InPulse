import { useEffect } from "react";
import type { NavigateFunction } from "react-router-dom";

import { navigatePrepared } from "@shared/routing/navigate-prepared";

export type AnchorPathPreparation = (
  path: string,
) => Promise<unknown> | undefined;

function sameLocation(url: URL): boolean {
  return (
    url.pathname === window.location.pathname &&
    url.search === window.location.search &&
    url.hash === window.location.hash
  );
}

/**
 * 同源内链统一改走 SPA 导航。
 *
 * 业务里仍有普通 a href 指向记录、任务和设置页；默认点击会整页刷新，绕过
 * 路由预取、页面过渡和弹窗状态。这里在冒泡阶段统一接管普通左键点击，同时保留
 * 新标签页、下载链接、外部链接、哈希锚点和显式 data-native-navigation 的原生行为。
 */
export function useGlobalAnchorNavigation(
  navigate: NavigateFunction,
  preparePath?: AnchorPathPreparation,
): void {
  useEffect(() => {
    const handleClick = (event: MouseEvent): void => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (anchor === null) {
        return;
      }
      if (anchor.closest("[data-native-navigation]") !== null) {
        return;
      }
      const rawTarget = anchor.getAttribute("target");
      if (rawTarget !== null && rawTarget !== "" && rawTarget !== "_self") {
        return;
      }
      if (anchor.hasAttribute("download")) {
        return;
      }
      const rawHref = anchor.getAttribute("href");
      if (
        rawHref === null ||
        rawHref.trim() === "" ||
        rawHref.startsWith("#")
      ) {
        return;
      }

      let url: URL;
      try {
        url = new URL(rawHref, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) {
        return;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        return;
      }
      if (sameLocation(url)) {
        return;
      }
      if (
        url.hash !== "" &&
        url.pathname === window.location.pathname &&
        url.search === window.location.search
      ) {
        return;
      }

      event.preventDefault();
      const path = url.pathname + url.search + url.hash;
      void navigatePrepared(
        navigate,
        path,
        preparePath === undefined ? {} : { prepare: () => preparePath(path) },
      );
    };

    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [navigate, preparePath]);
}
