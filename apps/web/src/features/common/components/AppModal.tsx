import { Modal, type ModalProps } from "antd";
import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";

import { InpulseIcon, type InpulseIconName } from "./InpulseIcon";

/**
 * 弹层宽度分档，与设计系统 `design-system.css` 的
 * `.surface-modal-md` / `-lg` / `-xl` 一一对应。
 *
 * 宽度只能由类名下发。antd 会把 `width` 写成 `.ant-modal` 的行内样式，
 * 优先级高于任何类规则，所以这里不接受 antd 的 `width`。
 */
export type ModalWidth = "md" | "lg" | "xl";

/**
 * 确认类弹层的语义色调：盒子顶部画 4px 色条，并给标题前的图标片定底色。
 * 色值与任务卡 tone 同源（红=危险、橙=警告、蓝=信息、绿=成功）；
 * 表单类弹层不传，保持纯悬浮卡。
 */
export type ModalTone = "danger" | "warning" | "info" | "success";

const WIDTH_CLASS: Record<ModalWidth, string> = {
  md: "surface-modal-md",
  lg: "surface-modal-lg",
  xl: "surface-modal-xl",
};

/** 复刻 `<dialog>.showModal()` 的初始焦点：落到盒内第一个可聚焦元素。 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

export interface AppModalProps extends Omit<
  ModalProps,
  "width" | "centered" | "footer"
> {
  /**
   * 宽度分档。默认 `md`，对应设计稿的模块/任务编辑与各类操作弹层；
   * 带侧栏说明（`.writing-context`）的表单弹层（如新建项目）用 `lg`，
   * 宽屏下说明列才会落到字段右侧（design-system.css 的两列规则只挂 lg/xl）。
   */
  readonly size?: ModalWidth;
  /** 语义色调；传了才渲染顶部 4px 色条，配合 `icon` 用于归档/删除/发布等确认弹层。 */
  readonly tone?: ModalTone | undefined;
  /** 标题前的图标片（38×38 圆角底 + 图标）。不传则不占位，标题仍在最左。 */
  readonly icon?: InpulseIconName | undefined;
  /**
   * 无障碍名称。不传时取 `title`、再取 `eyebrow` 的字符串值。
   * 供自渲 `.drawer-header` 的弹层（任务详情等）单独指定 `role="dialog"` 的名字。
   */
  readonly label?: string | undefined;
  /** 头部小标题，渲染为设计契约的 `.detail-label`（如「项目名 / 模块名」）。 */
  readonly eyebrow?: ReactNode;
  /** 关闭按钮的无障碍标签；设计稿按场景给出「关闭」「关闭任务详情」等文案。 */
  readonly closeLabel?: string;
  /**
   * 把 `children` 包进带内边距与滚动的 `.modal-body`。
   * 弹层内已自带 `.catalog-form` / `.dialog-form` / `.task-modal-*` 等正文容器时不要开启。
   */
  readonly body?: boolean;
  /**
   * 标题栏右侧、关闭按钮左边的操作位（ADR-076 的「AI 助手」入口）。
   * 不传时不占位；传入的节点自己负责样式与无障碍标签。
   */
  readonly headerActions?: ReactNode;
  /**
   * 弹层底部的操作区。设计稿里它是盒子的直接子级 `.calm-action-footer`，
   * 所以不接受 antd 的函数式 `footer`，也不再走 antd 的原生 footer。
   */
  readonly footer?: ReactNode;
  /**
   * 同一个弹层保持打开、只在内部切换内容时（如任务详情 → 编辑任务），
   * 传入随内容变化的稳定值。`active` 不变时打开逻辑不会重跑，
   * 靠这个值把初始焦点移回新内容的第一个可聚焦元素。
   */
  readonly focusToken?: string | number;
}

function mergeClass(...names: (string | undefined)[]): string {
  const classes = new Set<string>();
  for (const name of names) {
    for (const part of (name ?? "").split(/\s+/)) {
      if (part.length > 0) classes.add(part);
    }
  }
  return [...classes].join(" ");
}

/**
 * 打开中的 AppModal 栈（栈顶 = 最上层）。rc-dialog 的 Esc 依赖它自己的 Portal
 * 栈判定「是否顶层」，在本应用「常驻但关闭的弹层 + 多层叠加」混排下会误判，
 * 表现为 Esc 时灵时不灵；这里改由 AppModal 自己维护栈并在捕获阶段接管 Esc：
 * 只关栈顶、不穿透、关闭后焦点归还逻辑不变。
 */
const modalStack: symbol[] = [];

/**
 * 打开中的弹层数。滚动锁按它增减，避免多层弹层乱序关闭时提前解锁；
 * 计数归零时才把下面三处保存值回写。
 */
let scrollLocks = 0;
let bodyOverflowBeforeLock = "";
let rootOverflowBeforeLock = "";
let rootPaddingBeforeLock = "";

/**
 * 同时锁住 `body` 与仓库真正的根滚动器 `html`。design-system.css 给 `html` 设了
 * `overflow-y: scroll`（常显滚动条，让版式不随内容长短跳动），只锁 `body` 挡不住它：
 * 实测弹窗打开后背景仍能被滚轮滚走。隐藏根滚动条的同时把槽宽补成 `padding-right`，
 * 实测 `.app-shell` / `main` / `.sidebar` 几何完全不变，而视口回到整个窗口宽后，
 * 固定遮罩反而铺满右缘、不再留一条亮带。
 */
function lockScroll(): () => void {
  const root = document.documentElement;
  if (scrollLocks === 0) {
    // 槽宽必须在隐藏滚动条之前量。
    const gutter = window.innerWidth - root.clientWidth;
    bodyOverflowBeforeLock = document.body.style.overflow;
    rootOverflowBeforeLock = root.style.overflow;
    rootPaddingBeforeLock = root.style.paddingRight;
    document.body.style.overflow = "hidden";
    root.style.overflow = "hidden";
    if (gutter > 0) root.style.paddingRight = `${gutter}px`;
  }
  scrollLocks += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    scrollLocks -= 1;
    if (scrollLocks > 0) return;
    document.body.style.overflow = bodyOverflowBeforeLock;
    root.style.overflow = rootOverflowBeforeLock;
    root.style.paddingRight = rootPaddingBeforeLock;
  };
}

function labelOf(
  label: string | undefined,
  eyebrow: ReactNode,
  title: ReactNode,
): string | undefined {
  if (typeof label === "string" && label.trim().length > 0) return label;
  for (const candidate of [title, eyebrow]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * 仓库统一弹层入口，结构照抄设计稿 `surface-modal.tsx`：用 `modalRender` 顶掉
 * antd 的 header/body/footer，让 `.catalog-modal > .drawer-header`、
 * `.task-modal > .calm-tabs`、`.catalog-modal .dialog-form` 这些设计系统的子选择器
 * 直接命中盒子的子元素——多包一层 antd 容器它们会全部失配。
 * `modalRender` 只多插一层 `.ant-modal-render`，由 `antd-adapter.css` 抹平。
 *
 * 同时复刻 `<dialog>.showModal()` 的两件事：① 打开时聚焦盒内第一个可聚焦元素，
 * 关闭后把焦点还给触发元素；② 锁住页面滚动，不用 antd 的 `scrollLock`
 * ——它会给 body 补 `width: calc(100% - 15px)`，把背景布局挤窄 15px。
 * 滚动锁的细节见 `lockScroll`。
 *
 * 垂直居中由 `.surface-modal` 的 `position: fixed; inset: 0; margin: auto` 承担，
 * 因此 `centered` 与 `top` 都不再有意义；`title` 只用于头部排版，不再下发给 antd。
 *
 * antd 给 `.ant-modal` 挂了 `pointer-events: none`，只在它自己的 `.ant-modal-container`
 * 上还原；`modalRender` 绕开了那个容器，所以盒子必须自己带行内 `pointer-events: auto`，
 * 否则弹层在缺 CSS 的环境（jsdom 单测）里整块点不动。
 *
 * `footer` 不再交给 antd（原生 footer 会被顶掉），而是渲染成设计契约的
 * `.calm-action-footer`，与 `.catalog-form`、正文容器并列成为盒子的直接子级。
 */
export function AppModal({
  size = "md",
  tone,
  icon,
  label,
  eyebrow,
  closeLabel = "关闭",
  body = false,
  headerActions,
  footer,
  focusToken,
  title,
  closable,
  className,
  rootClassName,
  wrapClassName,
  open,
  onCancel,
  mask,
  maskClosable,
  children,
  ...props
}: AppModalProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  /**
   * 本次鼠标操作是否「按下与抬起都落在盒子自身留白」。拖选跨子元素松手时浏览器
   * 会把 click 的 target 合成到公共祖先（也就是盒子），单看 click 无法与真点留白
   * 区分，故用按下/抬起两点判定。
   */
  const boxPaddingPress = useRef(false);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  const stackIdRef = useRef<symbol | null>(null);
  if (stackIdRef.current === null) stackIdRef.current = Symbol("app-modal");

  const active = open === true;
  const maskConfig = typeof mask === "object" ? mask : undefined;
  const dismissable = (maskConfig?.closable ?? maskClosable) !== false;
  const canDismiss = closable !== false && dismissable;
  const hasHeader = eyebrow !== undefined || title !== undefined;
  // antd 6 已废弃 `maskClosable`，统一归一成 `mask.closable` 再下发。
  const mergedMask =
    typeof mask === "boolean" ? mask : { ...maskConfig, closable: dismissable };

  const priorFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    priorFocus.current = document.activeElement as HTMLElement | null;
    const unlock = lockScroll();
    return () => {
      unlock();
      const prior = priorFocus.current;
      priorFocus.current = null;
      if (prior?.isConnected) prior.focus({ preventScroll: true });
    };
  }, [active]);

  // 同一弹层保持打开、只替换内容时（任务详情 → 编辑任务），上面的打开逻辑
  // 不会重跑；靠 focusToken 把初始焦点移到新内容的第一个可聚焦元素。
  useEffect(() => {
    if (!active) return;
    boxRef.current
      ?.querySelector<HTMLElement>(FOCUSABLE)
      ?.focus({ preventScroll: true });
  }, [active, focusToken]);

  // 入栈/出栈：关闭与卸载都要把自己从栈里摘掉，避免残留项顶住 Esc。
  useEffect(() => {
    if (!active) return;
    const id = stackIdRef.current as symbol;
    modalStack.push(id);
    return () => {
      const at = modalStack.indexOf(id);
      if (at >= 0) modalStack.splice(at, 1);
    };
  }, [active]);

  // Esc 只关栈顶弹层：捕获阶段拦截，rc-dialog 与下层弹层都不会收到这次按键。
  useEffect(() => {
    if (!active || closable === false) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (modalStack[modalStack.length - 1] !== stackIdRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      cancel.current?.(
        event as unknown as Parameters<NonNullable<ModalProps["onCancel"]>>[0],
      );
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [active, closable]);

  const dismiss = (event: MouseEvent<HTMLElement>) => {
    cancel.current?.(
      event as unknown as Parameters<NonNullable<ModalProps["onCancel"]>>[0],
    );
  };
  // antd 的 `onCancel` 是必填项，而调用方可以不传（纯展示弹层），
  // 所以在 `exactOptionalPropertyTypes` 下必须兜一个稳定函数。
  const dismissRef = useRef<ModalProps["onCancel"]>(undefined);
  dismissRef.current = onCancel;
  const notifyCancel: NonNullable<ModalProps["onCancel"]> = (event) => {
    dismissRef.current?.(event);
  };

  return (
    <Modal
      {...props}
      open={active}
      footer={null}
      closable={false}
      keyboard={false}
      scrollLock={false}
      focusable={{ focusTriggerAfterClose: false }}
      className="surface-modal-dialog"
      rootClassName={mergeClass("surface-modal-root", rootClassName)}
      wrapClassName={mergeClass("surface-modal-wrap", wrapClassName)}
      mask={mergedMask}
      onCancel={notifyCancel}
      modalRender={() => (
        <div
          ref={boxRef}
          className={mergeClass(
            "surface-modal",
            WIDTH_CLASS[size],
            tone === undefined ? undefined : "tone-" + tone,
            className,
          )}
          style={{ pointerEvents: "auto" }}
          role="dialog"
          aria-modal="true"
          aria-label={labelOf(label, eyebrow, title)}
          onMouseDown={(event) => {
            boxPaddingPress.current = event.target === boxRef.current;
          }}
          onMouseUp={(event) => {
            boxPaddingPress.current =
              boxPaddingPress.current && event.target === boxRef.current;
          }}
          onClick={(event) => {
            // 设计稿里点击盒子自身的留白（不是子元素）也会关闭；但拖选跨子元素
            // （如在浮层输入框里选中一句话后在正文松手）时浏览器会把 click 的
            // target 合成到盒子，按下点其实在子元素上，这种合成 click 不关闭。
            const pressedOnPadding = boxPaddingPress.current;
            boxPaddingPress.current = false;
            if (
              canDismiss &&
              pressedOnPadding &&
              event.target === boxRef.current
            ) {
              dismiss(event);
            }
          }}
        >
          {hasHeader ? (
            <div className="drawer-header">
              {/* 图标片是可选装饰：只有确认类弹层传 `icon`，此时标题块整体右移一格。 */}
              <div
                className={icon === undefined ? undefined : "modal-head-main"}
              >
                {icon === undefined ? null : (
                  <span className="modal-chip" aria-hidden="true">
                    <InpulseIcon name={icon} size={19} />
                  </span>
                )}
                <div>
                  {eyebrow === undefined ? null : (
                    <span className="detail-label">{eyebrow}</span>
                  )}
                  {title === undefined ? null : <h2>{title}</h2>}
                </div>
              </div>
              {headerActions === undefined && closable === false ? null : (
                <div className="modal-head-actions">
                  {headerActions}
                  {closable === false ? null : (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={closeLabel}
                      onClick={dismiss}
                    >
                      <InpulseIcon name="x" size={19} />
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : null}
          {body ? <div className="modal-body">{children}</div> : children}
          {footer === undefined || footer === null ? null : (
            <div className="calm-action-footer">{footer}</div>
          )}
        </div>
      )}
    >
      {null}
    </Modal>
  );
}
