import type { AppRouteModule } from "@shared/routing/route-descriptor";

/**
 * 路由 chunk 预取（2026-10-10 用户指示
 *
 * 位置（2026-10-14）：实现从 `app/router/route-preload.ts` 移到 `shared/routing`。除 app 层的
 * 侧栏导航与项目树，pages / features 层的跳转入口（项目卡片、通知项、搜索结果、命令面板）也要用，
 * 而分层规则禁止它们反向依赖 app；旧路径保留同名 re-export，既有 import 与历史文档继续有效。
 * `import.meta.glob` 的相对路径 `../../pages/**` 在本目录与 `app/router` 同深度、指向同一批文件，无需改动。「所有跳转都要先缓冲、准备好了再呈现」）。
 *
 * 页面路由统一是 `React.lazy(() => import("./XxxPage"))`，chunk 没到之前路由级的 Suspense
 * 会先渲染「正在加载页面…」这版通用骨架。实测「遗留问题 → 审计日志」冷 chunk 下中间态要
 * 327ms（+61ms 出骨架 / +380ms 出内容），是切换里最明显的一闪。这里把「导航意图」
 * （悬停 / 按下 / 键盘聚焦）当作预取信号，提前把目标页面的 chunk 拉进模块缓存，
 * 真正点下去时 `lazy` 的 import 命中缓存、不再挂起，中间态基本不会再出现。
 *
 * 映射关系在构建期从文件系统推出，避免 17 个 route.ts 各写一份 preload：
 * - pages 目录下的 route.ts 用 eager glob 拿到每个路由模块的 URL path；
 * - pages 目录下以 Page.tsx 结尾的页面组件用惰性 glob 拿到模块（该后缀天然排除
 *   测试文件，不会把测试模块拖进构建图）；
 * - 同一个目录下的 route.ts 与页面组件配对，把 URL path 编译成正则。
 *
 * 预取失败（离线、chunk 404 等）只吞掉异常：它与能否导航无关，真正的 import 会再试一次。
 */

const routeFiles = import.meta.glob<{
  default?: AppRouteModule;
  route?: AppRouteModule;
}>("../../pages/**/route.ts", { eager: true });

const pageChunks = import.meta.glob("../../pages/**/*Page.tsx");

interface RoutePreloadEntry {
  readonly pattern: RegExp;
  readonly preload: () => Promise<void>;
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** 把路由 path 编译成匹配真实地址的正则；`:id?` 这种可选段也要能命中（功能档案页）。 */
function pathPatternOf(routePath: string): RegExp {
  let source = "";
  for (const segment of routePath.split("/")) {
    if (segment === "") {
      continue;
    }
    if (segment.startsWith(":")) {
      source += segment.endsWith("?") ? "(?:/[^/]+)?" : "/[^/]+";
    } else {
      source += "/" + segment.replace(REGEX_SPECIAL, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function buildEntries(): RoutePreloadEntry[] {
  const entries: RoutePreloadEntry[] = [];
  const chunkKeys = Object.keys(pageChunks);
  for (const file of Object.keys(routeFiles)) {
    const mod = routeFiles[file];
    const route = mod?.default ?? mod?.route;
    const routePath = route?.path;
    // 兜底路由（not-found 的 `*`）不参与预取：它匹配一切，会把其它条目全挡住。
    if (routePath === undefined || routePath.includes("*")) {
      continue;
    }
    const dir = file.slice(0, file.lastIndexOf("/") + 1);
    const chunkKey = chunkKeys.find((key) => key.startsWith(dir));
    const load = chunkKey === undefined ? undefined : pageChunks[chunkKey];
    if (load === undefined) {
      continue;
    }
    entries.push({
      pattern: pathPatternOf(routePath),
      // 返回 Promise 让调用方能在「内容已经就绪」后再切换路由：先关弹窗再等
      // chunk 会让用户看到一帧空列表 / 骨架，再整页重建，观感就是闪一下。
      preload: () =>
        load()
          .then(() => undefined)
          .catch(() => undefined),
    });
  }
  return entries;
}

const routePreloadEntries = buildEntries();

/**
 * 把某个地址的页面 chunk 提前拉进模块缓存；没有匹配路由时立即完成。
 * 返回值总是 resolve：预取失败不能阻断真正的导航。
 */
export function preloadRoutePath(url: string): Promise<void> {
  const path = url.split("?")[0] ?? "";
  for (const entry of routePreloadEntries) {
    if (entry.pattern.test(path)) {
      return entry.preload();
    }
  }
  return Promise.resolve();
}

/**
 * 导航项的预取事件集合：鼠标悬停、按下、键盘聚焦都算「马上要点进去了」。
 * 展开给侧栏导航与项目树复用，省得每处重复写三个 handler。
 */
export function routePreloadHandlers(path: string) {
  const preload = () => {
    void preloadRoutePath(path);
  };
  return {
    onPointerEnter: preload,
    onPointerDown: preload,
    onFocus: preload,
  } as const;
}
