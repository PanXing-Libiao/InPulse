import React from "react";
import { InpulseIcon, type InpulseIconName } from "./InpulseIcon";

export type CalmBadgeTone =
  "gray" | "blue" | "green" | "red" | "amber" | "violet" | "cyan" | "leftover";

export const CalmBadge: React.FC<{
  readonly children: React.ReactNode;
  readonly tone?: CalmBadgeTone;
  readonly title?: string;
}> = ({ children, tone = "gray", title }) => (
  <span className={"badge badge-" + tone} title={title}>
    {children}
  </span>
);

export const CalmEmptyState: React.FC<{
  readonly icon: InpulseIconName;
  readonly title: string;
  readonly description?: string;
  readonly children?: React.ReactNode;
}> = ({ icon, title, description, children }) => (
  <div className="calm-empty calm-empty-state">
    <InpulseIcon name={icon} size={25} />
    <strong>{title}</strong>
    {description ? <p>{description}</p> : null}
    {children}
  </div>
);

export const CalmSectionTitle: React.FC<{
  readonly title: string;
  readonly hint?: string;
  /** 紧贴标题右侧的附加节点（如草稿箱的展开/收起小按钮）。 */
  readonly titleSuffix?: React.ReactNode;
  readonly children?: React.ReactNode;
  /** 提供后标题行成为展开/收起切换按钮（箭头随状态旋转）。 */
  readonly collapsible?: {
    readonly expanded: boolean;
    readonly onToggle: () => void;
    readonly controls?: string;
  };
}> = ({ title, hint, titleSuffix, children, collapsible }) => (
  <div className="calm-section-title">
    {collapsible ? (
      <button
        type="button"
        className="calm-section-toggle"
        aria-expanded={collapsible.expanded}
        {...(collapsible.controls === undefined
          ? {}
          : { "aria-controls": collapsible.controls })}
        onClick={collapsible.onToggle}
      >
        <InpulseIcon
          name="chevron"
          size={14}
          {...(collapsible.expanded ? { className: "expanded" } : {})}
        />
        <span className="calm-section-toggle-text">
          <span className="calm-section-toggle-title">{title}</span>
          {hint ? <small>{hint}</small> : null}
        </span>
      </button>
    ) : (
      <div>
        <div className="calm-section-title-head">
          <h3>{title}</h3>
          {titleSuffix ?? null}
        </div>
        {hint ? <small>{hint}</small> : null}
      </div>
    )}
    {children}
  </div>
);

/**
 * 分段控件切换滑块（2026-09-22）：选中底色与投影从 .selected 按钮迁到滑块上，
 * 位置与尺寸取自选中按钮的实测矩形，因此各调用处的 padding / gap / 字号差异都
 * 不会让它错位。CalmSegmented 与手写 .segmented（任务看板工具栏）共用同一套
 * 测量逻辑，保证同一控件只有一种行为。
 */
export type CalmSegmentedThumbBox = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

const isSameThumb = (
  a: CalmSegmentedThumbBox,
  b: CalmSegmentedThumbBox,
): boolean =>
  a.left === b.left &&
  a.top === b.top &&
  a.width === b.width &&
  a.height === b.height;

export const useCalmSegmentedThumb = (): {
  readonly trackRef: React.RefObject<HTMLDivElement | null>;
  readonly thumb: CalmSegmentedThumbBox | null;
} => {
  const trackRef = React.useRef<HTMLDivElement | null>(null);
  const [thumb, setThumb] = React.useState<CalmSegmentedThumbBox | null>(null);

  // 以 aria-pressed 反查选中按钮，测量函数因此不依赖 value / options，
  // 可以稳定地同时供 layout effect 与 ResizeObserver 使用。
  const measure = React.useCallback(() => {
    const track = trackRef.current;
    const button =
      track === null
        ? null
        : track.querySelector<HTMLButtonElement>("button[aria-pressed=true]");
    if (track === null || button === null) {
      setThumb(null);
      return;
    }
    const trackBox = track.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    const next: CalmSegmentedThumbBox = {
      left: buttonBox.left - trackBox.left,
      top: buttonBox.top - trackBox.top,
      width: buttonBox.width,
      height: buttonBox.height,
    };
    // 值没变就回传同一个对象，让 React 跳过重渲染，避免测量自转。
    setThumb((prev) =>
      prev !== null && isSameThumb(prev, next) ? prev : next,
    );
  }, []);

  // 每次渲染后重测：选中档位或数量角标变化（按钮宽度随之变化）时，
  // 滑块在新位置起步，位移过渡交给 CSS。
  React.useLayoutEffect(measure);

  // 窗口缩放、字体加载、弹窗由隐藏转显示都会改变按钮尺寸，交给
  // ResizeObserver 兜底，滑块始终贴合选中按钮。
  React.useLayoutEffect(() => {
    const track = trackRef.current;
    if (track === null || typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    track
      .querySelectorAll("button")
      .forEach((button) => observer.observe(button));
    return () => observer.disconnect();
  }, [measure]);

  return { trackRef, thumb };
};

/**
 * 切换滑块本体：只在测量完成后挂载，因此首次出现不会从左侧滑进来；
 * 底色、圆角与投影取值与原 .selected 完全一致，观感不变。
 */
export const CalmSegmentedThumb: React.FC<{
  readonly box: CalmSegmentedThumbBox | null;
}> = ({ box }) =>
  box === null ? null : (
    <span
      className="segmented-thumb"
      aria-hidden="true"
      style={{
        width: box.width + "px",
        height: box.height + "px",
        transform: "translate(" + box.left + "px, " + box.top + "px)",
      }}
    />
  );

export const CalmSegmented = <T extends string>({
  value,
  options,
  onChange,
  label,
  equalWidth = false,
}: {
  readonly value: T;
  readonly options: ReadonlyArray<{
    readonly value: T;
    readonly label: string;
    /**
     * 可选：该档位的数量。数量角标对辅助技术隐藏（与侧栏导航计数同口径），
     * 因此 null 与缺省都表示「不可知」——不渲染角标，也不显示会被读成
     * 「0 项」的假零；传 0 才渲染 0。
     */
    readonly count?: number | null | undefined;
    /** 可选：业务上不可达的档位，例如项目状态里的越级切换。 */
    readonly disabled?: boolean | undefined;
    /** 可选：禁用原因，鼠标悬停时解释给使用者。 */
    readonly title?: string | undefined;
  }>;
  readonly onChange: (value: T) => void;
  readonly label: string;
  /**
   * 两档或多档等宽槽位：按钮始终平分轨道，数量角标不会改变选中滑块宽度。
   * 仅用于需要固定滑块视觉位置的筛选器，不影响其它分段控件。
   */
  readonly equalWidth?: boolean | undefined;
}) => {
  const { trackRef, thumb } = useCalmSegmentedThumb();

  return (
    <div
      className={
        "segmented segmented-slide" +
        (equalWidth ? " segmented-equal-width" : "")
      }
      role="group"
      aria-label={label}
      ref={trackRef}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          className={value === option.value ? "selected" : ""}
          disabled={option.disabled ?? false}
          title={option.title}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {typeof option.count === "number" ? (
            <em
              className="segmented-count"
              aria-hidden="true"
              title={option.label + " " + option.count + " 项"}
            >
              {option.count}
            </em>
          ) : null}
        </button>
      ))}
      <CalmSegmentedThumb box={thumb} />
    </div>
  );
};

/**
 * C-3：设计师稿 task-modal 的「任务内容」标签栏（`calm-tabs`）——一行标签 +
 * 一根底部细线，选中态用 2px 下边框；内容区由调用方按 activeKey 渲染，
 * 标签文案（如 `迭代记录 3`、`合并与分支 · #12`）也由调用方组装。
 */
export const CalmTabs = <K extends string>({
  label,
  activeKey,
  items,
  onChange,
  className = "calm-tabs",
}: {
  readonly label: string;
  readonly activeKey: K;
  readonly items: ReadonlyArray<{
    readonly key: K;
    readonly label: React.ReactNode;
  }>;
  readonly onChange: (key: K) => void;
  readonly className?: string;
}) => (
  <div className={className} role="tablist" aria-label={label}>
    {items.map((item) => (
      <button
        key={item.key}
        type="button"
        role="tab"
        aria-selected={activeKey === item.key}
        className={activeKey === item.key ? "selected" : ""}
        onClick={() => onChange(item.key)}
      >
        {item.label}
      </button>
    ))}
  </div>
);
