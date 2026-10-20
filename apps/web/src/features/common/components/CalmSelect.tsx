import React from "react";
import { ConfigProvider, Select, type ThemeConfig } from "antd";
import { CalmBadge, type CalmBadgeTone } from "./Calm";
import { InpulseIcon } from "./InpulseIcon";
import "./calm-select.css";

/**
 * 通用下拉选择器：基于 antd Select，复用其键盘、ARIA 与弹层行为，视觉上提供
 * 三种形态（对齐设计评审的三种下拉风格）。
 *
 * - \`menu\`：浅色菜单（圆点 + 中性灰选中底 + 对勾），适合状态/优先级这类短选项。
 * - \`rich\`：富信息项（方形图标 + 标题/副标题 + 状态徽标），适合项目切换。
 * - \`member\`：成员选项（头像 + 姓名 + 勾选），默认开启输入搜索。
 * - \`notion\`：Notion 风极简面板（暖黑文字、紧凑行、多层柔和阴影），适合层级/范围切换。
 */
export type CalmSelectAppearance = "menu" | "rich" | "member" | "notion";

export interface CalmSelectOption {
  readonly value: number | string;
  readonly label: string;
  /** rich 副标题 / member 补充说明（如「可保留」）。 */
  readonly description?: string | undefined;
  /** notion：选项与触发器前缀 emoji（如 🎯）。 */
  readonly emoji?: string | undefined;
  /** menu：选项左侧圆点颜色（状态色）。 */
  readonly dotColor?: string | undefined;
  /** rich：图标方块内短文字；缺省取 label 首字。 */
  readonly iconText?: string | undefined;
  /** rich：图标方块底色；缺省按名称取稳定色。 */
  readonly iconColor?: string | undefined;
  /** rich：右侧徽标。 */
  readonly badge?:
    | { readonly text: string; readonly tone?: CalmBadgeTone | undefined }
    | undefined;
  /** member：头像地址；缺省用姓名首字色块。 */
  readonly avatarUrl?: string | null | undefined;
  /**
   * 分组标题（ADR-081）：相同文本的选项在弹层中按首次出现顺序聚成一组，
   * 组标题即该文本；缺省表示不分组、平铺展示。
   */
  readonly group?: string | undefined;
  readonly disabled?: boolean | undefined;
}

interface CalmSelectBaseProps {
  readonly options: readonly CalmSelectOption[];
  readonly appearance?: CalmSelectAppearance | undefined;
  readonly placeholder?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly loading?: boolean | undefined;
  /** 是否允许输入搜索；member 形态默认开启。 */
  readonly searchable?: boolean | undefined;
  /**
   * 服务端搜索：传入后由调用方按关键词取数（过滤发生在远端），组件关闭本地
   * `filterOption`，选项即调用方当前提供的列表；需与 `searchable` 一起使用。
   */
  readonly onSearch?: ((value: string) => void) | undefined;
  /** 弹层无匹配项时的内容；缺省用 antd 空态。 */
  readonly notFoundContent?: React.ReactNode;
  readonly className?: string | undefined;
  readonly ariaLabel?: string | undefined;
  /** 触发器内部输入框的 id；与 <label htmlFor> 配合保持表单语义。 */
  readonly id?: string | undefined;
  /** 触发器宽度（数字按 px）；不设置时随内容自适应。 */
  readonly width?: number | string | undefined;
  /** 弹层启用进入/离开动画。全局主题关闭了 antd motion，这里按需为弹层局部开启。 */
  readonly animated?: boolean | undefined;
  /** 固定向下展开；下方空间不足时也不自动翻到触发器上方。 */
  readonly forcePopupBelow?: boolean | undefined;
}

export interface CalmSelectProps extends CalmSelectBaseProps {
  readonly value: number | string | null | undefined;
  readonly onChange: (value: number | string) => void;
  readonly onBlur?: (() => void) | undefined;
  readonly multiple?: false | undefined;
}

/**
 * 多选形态：值与回调换成数组，触发器渲染为可逐个移除的标签。
 * 搜索与勾选行为与单选一致，弹层在每次选择后保持展开。
 */
export interface CalmMultiSelectProps extends CalmSelectBaseProps {
  readonly multiple: true;
  readonly value: readonly (number | string)[];
  readonly onChange: (values: readonly (number | string)[]) => void;
  /** 触发器最多展示的标签数，超出折叠为 +N；默认 2；"responsive" 表示按可用宽度尽量多显示。 */
  readonly maxTagCount?: number | "responsive" | undefined;
}

export type CalmSelectComponentProps = CalmSelectProps | CalmMultiSelectProps;

/** 成员头像色板：与设计系统的好友色一致，按姓名取稳定色。 */
const AVATAR_COLORS = [
  "#1467d8",
  "#7a5af5",
  "#4a9278",
  "#c9821a",
  "#c0453f",
  "#2f7d9e",
] as const;

export function avatarColorOf(name: string): string {
  let hash = 0;
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    hash = (hash * 31 + code) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? "#1467d8";
}

const iconTextOf = (option: CalmSelectOption) =>
  option.iconText ?? option.label.slice(0, 1);

/**
 * 本地过滤：label + description 的大小写不敏感包含匹配。服务端搜索模式下结果集由
 * 远端决定（远端可能按编号等本地看不到的字段命中），此时组件改用 `filterOption={false}`。
 */
function filterOptionByLabel(input: string, option?: unknown): boolean {
  const needle = input.trim().toLowerCase();
  if (needle.length === 0) {
    return true;
  }
  const data = option as unknown as CalmSelectOption | undefined;
  if (data === undefined) {
    return false;
  }
  const haystack = (data.label + " " + (data.description ?? "")).toLowerCase();
  return haystack.includes(needle);
}

const OptionAvatar: React.FC<{ readonly option: CalmSelectOption }> = ({
  option,
}) =>
  option.avatarUrl ? (
    <img className="calm-select-avatar" src={option.avatarUrl} alt="" />
  ) : (
    <span
      className="calm-select-avatar"
      aria-hidden="true"
      style={{ background: avatarColorOf(option.label) }}
    >
      {option.label.slice(0, 1)}
    </span>
  );

/** 全局主题关闭了 antd motion（外观零差异约束）；这里只让 CalmSelect 弹层恢复动效，
 * 进入/离开关键帧由 calm-select.css 按 .calm-select-popup 接管。 */
const motionEnabledTheme: ThemeConfig = {
  inherit: true,
  token: { motion: true },
};

export const CalmSelect: React.FC<CalmSelectComponentProps> = (props) => {
  const {
    options,
    appearance = "menu",
    placeholder,
    disabled,
    loading,
    searchable,
    onSearch,
    notFoundContent,
    className,
    ariaLabel,
    id,
    width,
    animated,
    forcePopupBelow,
  } = props;
  const multiple = props.multiple === true;
  const withSearch = searchable ?? appearance === "member";
  /**
   * 选项值与当前值按字符串比对：项目筛选器一侧来自 URL/筛选参数（数字），
   * 另一侧由 projectSelectOption 统一产出字符串，精确匹配会让触发器回退成裸 id。
   */
  const valueKey = (raw: number | string | null | undefined) =>
    raw === null || raw === undefined ? "" : String(raw);
  const byValue = React.useMemo(() => {
    const map = new Map<string, CalmSelectOption>();
    for (const option of options) {
      const key = valueKey(option.value);
      if (!map.has(key)) {
        map.set(key, option);
      }
    }
    return map;
  }, [options]);

  /**
   * antd 弹层选项：出现 group 时按首次出现顺序成组（组标题为分组文本），
   * 未分组的选项平铺在最后；无任何 group 时保持原有平铺行为不变。
   */
  const antdOptions = React.useMemo(() => {
    const toLeaf = (option: CalmSelectOption) => ({
      ...option,
      disabled: option.disabled ?? false,
    });
    const hasGroups = options.some(
      (option) => (option.group ?? "").trim().length > 0,
    );
    if (!hasGroups) {
      return options.map(toLeaf);
    }
    const order: string[] = [];
    const buckets = new Map<string, CalmSelectOption[]>();
    const ungrouped: CalmSelectOption[] = [];
    for (const option of options) {
      const group = (option.group ?? "").trim();
      if (group.length === 0) {
        ungrouped.push(option);
        continue;
      }
      if (!buckets.has(group)) {
        buckets.set(group, []);
        order.push(group);
      }
      buckets.get(group)?.push(option);
    }
    return [
      ...order.map((group) => ({
        label: <span className="calm-select-group-title">{group}</span>,
        options: (buckets.get(group) ?? []).map(toLeaf),
      })),
      ...ungrouped.map(toLeaf),
    ];
  }, [options]);

  const selectedValues: readonly (number | string)[] =
    props.multiple === true
      ? props.value
      : props.value === null || props.value === undefined
        ? []
        : [props.value];
  const selectedKeys = new Set(selectedValues.map(valueKey));

  const hasEmptyOption = byValue.has("");
  const selectedOption =
    props.multiple === true || props.value === null || props.value === undefined
      ? undefined
      : byValue.get(valueKey(props.value));
  const isPlaceholder = (raw: number | string | null | undefined) =>
    raw === null || raw === undefined || (raw === "" && !hasEmptyOption);

  const notionPrefix = (option: CalmSelectOption) =>
    option.emoji ? (
      <span className="calm-select-emoji" aria-hidden="true">
        {option.emoji}
      </span>
    ) : null;

  const richIcon = (option: CalmSelectOption) => (
    <span
      className="calm-select-rich-icon"
      style={{ background: option.iconColor ?? avatarColorOf(option.label) }}
    >
      {iconTextOf(option)}
    </span>
  );

  const renderTrigger = (raw: number | string | undefined) => {
    if (raw === undefined) {
      return null;
    }
    const option = byValue.get(valueKey(raw));
    if (!option) {
      return <span className="calm-select-trigger-label">{String(raw)}</span>;
    }
    if (appearance === "rich") {
      return (
        <span className="calm-select-trigger">
          {richIcon(option)}
          <span className="calm-select-trigger-label">{option.label}</span>
        </span>
      );
    }
    if (appearance === "member") {
      return (
        <span className="calm-select-trigger">
          <OptionAvatar option={option} />
          <span className="calm-select-trigger-label">{option.label}</span>
        </span>
      );
    }
    if (appearance === "notion") {
      return (
        <span className="calm-select-trigger">
          {notionPrefix(option)}
          <span className="calm-select-trigger-label">{option.label}</span>
        </span>
      );
    }
    return (
      <span className="calm-select-trigger">
        {option.dotColor ? (
          <span
            className="calm-select-dot"
            style={{ background: option.dotColor }}
          />
        ) : null}
        <span className="calm-select-trigger-label">{option.label}</span>
      </span>
    );
  };

  const check = (
    <InpulseIcon name="check" size={14} className="calm-select-check" />
  );

  const renderOption = (option: CalmSelectOption) => {
    const selected = selectedKeys.has(valueKey(option.value));
    if (appearance === "rich") {
      return (
        <span className="calm-select-rich-item">
          {richIcon(option)}
          <span className="calm-select-rich-text">
            <span className="calm-select-rich-title">{option.label}</span>
            {option.description ? (
              <span className="calm-select-rich-desc">
                {option.description}
              </span>
            ) : null}
          </span>
          {option.badge ? (
            <CalmBadge tone={option.badge.tone ?? "blue"}>
              {option.badge.text}
            </CalmBadge>
          ) : selected ? (
            check
          ) : null}
        </span>
      );
    }
    if (appearance === "member") {
      return (
        <span className="calm-select-member-item">
          <OptionAvatar option={option} />
          <span className="calm-select-member-name">{option.label}</span>
          {option.description ? (
            <span className="calm-select-member-note">
              {option.description}
            </span>
          ) : null}
          {selected ? check : null}
        </span>
      );
    }
    if (appearance === "notion") {
      return (
        <span className="calm-select-notion-item">
          {notionPrefix(option)}
          <span className="calm-select-notion-label">{option.label}</span>
          {selected ? check : null}
        </span>
      );
    }
    return (
      <span className="calm-select-menu-item">
        {option.dotColor ? (
          <span
            className="calm-select-dot"
            style={{ background: option.dotColor }}
          />
        ) : null}
        <span className="calm-select-menu-label">{option.label}</span>
        {selected ? check : null}
      </span>
    );
  };

  const rootClass = [
    "calm-select",
    "calm-select-" + appearance,
    multiple ? "calm-select-multiple" : "",
    className ?? "",
  ]
    .filter((part) => part.length > 0)
    .join(" ");

  const selectValue =
    props.multiple === true
      ? [...props.value]
      : isPlaceholder(props.value)
        ? undefined
        : (selectedOption?.value ?? props.value);

  const selectNode = (
    <Select
      className={rootClass}
      classNames={{
        popup: {
          root:
            "calm-select-popup calm-select-popup-" +
            appearance +
            (animated === true ? " calm-select-popup-animated" : ""),
        },
      }}
      {...(multiple ? { mode: "multiple" as const } : {})}
      {...(props.multiple === true
        ? { maxTagCount: props.maxTagCount ?? 2 }
        : {})}
      value={selectValue}
      onChange={(next: unknown) => {
        if (props.multiple === true) {
          props.onChange(
            Array.isArray(next) ? (next as (number | string)[]) : [],
          );
          return;
        }
        if (next !== undefined) {
          props.onChange(next as number | string);
        }
      }}
      onBlur={() => {
        if (props.multiple !== true) {
          props.onBlur?.();
        }
      }}
      options={antdOptions}
      labelRender={(label) => {
        const raw = label.value;
        return raw === undefined ? null : renderTrigger(raw);
      }}
      optionRender={(option) => {
        const data = option.data as unknown as CalmSelectOption | undefined;
        return data && data.label !== undefined ? renderOption(data) : null;
      }}
      placeholder={placeholder}
      disabled={disabled ?? false}
      loading={loading ?? false}
      showSearch={withSearch}
      {...(onSearch === undefined ? {} : { onSearch })}
      {...(notFoundContent === undefined ? {} : { notFoundContent })}
      filterOption={onSearch === undefined ? filterOptionByLabel : false}
      // antd 多选模式自带选中图标，会和 optionRender 里按形态渲染的勾重复成一个选项两个勾；
      // 这里关掉自带的，选中态统一由 `.calm-select-check` 表达。
      menuItemSelectedIcon={null}
      suffixIcon={<InpulseIcon name="chevronDown" size={14} />}
      popupMatchSelectWidth={false}
      {...(appearance === "member" ? { listHeight: 240 } : {})}
      {...(forcePopupBelow === true
        ? {
            placement: "bottomLeft" as const,
            builtinPlacements: {
              bottomLeft: {
                points: ["tl", "bl"] as [string, string],
                offset: [0, 4] as [number, number],
                overflow: { adjustX: true, adjustY: false, shiftY: true },
                htmlRegion: "visible" as const,
                dynamicInset: true,
              },
            },
          }
        : {})}
      {...(width === undefined ? {} : { style: { width } })}
      aria-label={ariaLabel}
      {...(id === undefined ? {} : { id })}
    />
  );

  return animated === true ? (
    <ConfigProvider theme={motionEnabledTheme}>{selectNode}</ConfigProvider>
  ) : (
    selectNode
  );
};
