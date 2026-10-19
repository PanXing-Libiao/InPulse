import React from "react";
import { ConfigProvider } from "antd";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { avatarColorOf, CalmSelect, type CalmSelectOption } from "./CalmSelect";

const statusOptions: readonly CalmSelectOption[] = [
  { value: "TODO", label: "未完成", dotColor: "#1467d8" },
  { value: "DONE", label: "已完成", dotColor: "#4a9278" },
  { value: "CANCELED", label: "已取消", dotColor: "#a0adb9" },
  { value: "ALL", label: "全部状态" },
];

const memberOptions: readonly CalmSelectOption[] = [
  { value: 5, label: "林晚晴" },
  { value: 7, label: "周子昂", description: "可保留" },
  { value: 9, label: "陈默" },
];

const projectOptions: readonly CalmSelectOption[] = [
  {
    value: 1,
    label: "InPulse 平台",
    description: "24 名成员",
    badge: { text: "进行中", tone: "blue" },
  },
  {
    value: 2,
    label: "数据中台",
    description: "12 名成员",
    badge: { text: "维护中", tone: "gray" },
  },
];

function mount(ui: React.ReactElement) {
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>{ui}</ConfigProvider>,
  );
}

function openSelect(container: HTMLElement) {
  const trigger = container.querySelector(".ant-select");
  if (!trigger) {
    throw new Error("ant-select trigger not found");
  }
  fireEvent.mouseDown(trigger);
}

function dropdownOf() {
  const dropdown = document.querySelector(".ant-select-dropdown");
  if (!dropdown) {
    throw new Error("dropdown not found");
  }
  return dropdown as HTMLElement;
}

describe("CalmSelect", () => {
  it("menu 形态：触发器显示当前值，选择后回调新值且选中项带对勾", () => {
    const onChange = vi.fn();
    const view = mount(
      <CalmSelect
        value="TODO"
        onChange={onChange}
        options={statusOptions}
        ariaLabel="任务状态筛选"
      />,
    );
    const trigger = view.container.querySelector(".ant-select-content");
    expect(trigger?.textContent).toBe("未完成");

    openSelect(view.container);
    const dropdown = dropdownOf();
    expect(within(dropdown).getByText("已完成")).toBeInTheDocument();
    expect(within(dropdown).getByText("全部状态")).toBeInTheDocument();
    // 选中项渲染对勾。
    expect(
      dropdown.querySelectorAll(
        ".ant-select-item-option-selected .calm-select-check",
      ),
    ).toHaveLength(1);

    fireEvent.click(within(dropdown).getByText("已完成"));
    expect(onChange).toHaveBeenCalledWith("DONE");
  });

  it("member 形态：默认可以输入搜索并按姓名与说明过滤", () => {
    const view = mount(
      <CalmSelect
        value={5}
        onChange={() => {}}
        options={memberOptions}
        appearance="member"
        ariaLabel="负责人"
      />,
    );
    openSelect(view.container);
    const dropdown = dropdownOf();
    expect(within(dropdown).getByText("周子昂")).toBeInTheDocument();

    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "可保留" } });
    expect(within(dropdown).queryByText("林晚晴")).not.toBeInTheDocument();
    expect(within(dropdown).getByText("周子昂")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "陈" } });
    expect(within(dropdown).queryByText("周子昂")).not.toBeInTheDocument();
    expect(within(dropdown).getByText("陈默")).toBeInTheDocument();
  });

  it("group 字段：弹层按分组标题聚组渲染，未分组选项平铺在最后", () => {
    const groupedOptions: readonly CalmSelectOption[] = [
      { value: 1, label: "张三", group: "研发一组" },
      { value: 3, label: "王五", group: "市场部" },
      { value: 2, label: "李四", group: "研发一组" },
      { value: 4, label: "赵六" },
    ];
    const view = mount(
      <CalmSelect
        appearance="member"
        multiple
        value={[]}
        onChange={() => {}}
        options={groupedOptions}
        ariaLabel="选择成员"
      />,
    );
    openSelect(view.container);
    const dropdown = dropdownOf();
    const groupTitles = [
      ...dropdown.querySelectorAll(".calm-select-group-title"),
    ].map((element) => element.textContent);
    expect(groupTitles).toEqual(["研发一组", "市场部"]);
    const order = [
      ...dropdown.querySelectorAll(".calm-select-member-name"),
    ].map((element) => element.textContent);
    expect(order).toEqual(["张三", "李四", "王五", "赵六"]);
  });

  it("multiple 形态：连续多选按数组回调、标签上限 2 并保留原生输入框类名", () => {
    const onChange = vi.fn();
    function StatefulMulti() {
      const [selected, setSelected] = React.useState<readonly number[]>([]);
      return (
        <CalmSelect
          value={selected}
          onChange={(next) => {
            onChange(next);
            setSelected(next.map(Number));
          }}
          options={memberOptions}
          appearance="member"
          multiple
          ariaLabel="选择成员"
        />
      );
    }
    const view = mount(<StatefulMulti />);
    expect(
      view.container.querySelector(".calm-select-multiple"),
    ).not.toBeNull();

    openSelect(view.container);
    fireEvent.click(within(dropdownOf()).getByText("林晚晴"));
    fireEvent.click(within(dropdownOf()).getByText("周子昂"));
    expect(onChange).toHaveBeenNthCalledWith(1, [5]);
    expect(onChange).toHaveBeenNthCalledWith(2, [5, 7]);

    fireEvent.click(within(dropdownOf()).getByText("陈默"));
    expect(onChange).toHaveBeenNthCalledWith(3, [5, 7, 9]);
    // maxTagCount 默认 2：前两个值渲染成标签，第 3 个折叠成「+ N」计数项
    // （计数项自身也是 `.ant-select-selection-item`）。
    const tagTexts = [
      ...view.container.querySelectorAll(".ant-select-selection-item"),
    ].map((node) => node.textContent ?? "");
    expect(tagTexts).toHaveLength(3);
    expect(tagTexts.filter((text) => text.includes("林晚晴"))).toHaveLength(1);
    expect(tagTexts.filter((text) => text.includes("周子昂"))).toHaveLength(1);
    expect(tagTexts.some((text) => /\+.*1/.test(text))).toBe(true);
    expect(tagTexts.some((text) => text.includes("陈默"))).toBe(false);
    // antd 多选模式会额外渲染一个自带选中图标（`.ant-select-item-option-state` 内），
    // 与 optionRender 里的 `.calm-select-check` 重复成一个选项两个勾；这里锁定只剩一个。
    const selectedRows = [
      ...dropdownOf().querySelectorAll(".ant-select-item-option-selected"),
    ];
    expect(selectedRows).toHaveLength(3);
    for (const row of selectedRows) {
      expect(row.querySelectorAll(".calm-select-check")).toHaveLength(1);
      expect(
        row.querySelector(".ant-select-item-option-state")?.innerHTML,
      ).toBe("");
    }
    // 触发器内输入框的复位样式挂在 antd 6 的 `.ant-select-input` 上：类名变化会让宿主表单
    // 的边框/内边距样式重新把这个小输入框露出来，因此在这里锁定类名契约。
    expect(view.container.querySelector(".ant-select-input")).not.toBeNull();
  });

  it("multiple 形态：disabled 选项渲染成不可移除的标签", () => {
    const view = mount(
      <CalmSelect
        value={[5, 7]}
        onChange={() => {}}
        options={[
          { value: 5, label: "林晚晴", disabled: true },
          { value: 7, label: "周子昂" },
        ]}
        appearance="member"
        multiple
        ariaLabel="选择成员"
      />,
    );
    const tags = [
      ...view.container.querySelectorAll(".ant-select-selection-item"),
    ];
    expect(tags).toHaveLength(2);
    const locked = tags.find((tag) =>
      (tag.textContent ?? "").includes("林晚晴"),
    );
    const removable = tags.find((tag) =>
      (tag.textContent ?? "").includes("周子昂"),
    );
    expect(
      locked?.querySelector(".ant-select-selection-item-remove"),
    ).toBeNull();
    expect(
      removable?.querySelector(".ant-select-selection-item-remove"),
    ).not.toBeNull();
  });

  it("rich 形态：渲染副标题与状态徽标", () => {
    const view = mount(
      <CalmSelect
        value={1}
        onChange={() => {}}
        options={projectOptions}
        appearance="rich"
        ariaLabel="选择项目"
      />,
    );
    openSelect(view.container);
    const dropdown = dropdownOf();
    expect(within(dropdown).getByText("InPulse 平台")).toBeInTheDocument();
    expect(within(dropdown).getByText("24 名成员")).toBeInTheDocument();
    expect(within(dropdown).getByText("12 名成员")).toBeInTheDocument();
    expect(within(dropdown).getByText("进行中")).toBeInTheDocument();
    expect(within(dropdown).getByText("维护中")).toBeInTheDocument();
  });

  it("禁用时点击不会打开选项列表", () => {
    const view = mount(
      <CalmSelect
        value="TODO"
        onChange={() => {}}
        options={statusOptions}
        disabled
        ariaLabel="任务状态筛选"
      />,
    );
    openSelect(view.container);
    expect(view.container.querySelector(".ant-select-item-option")).toBeNull();
  });

  it("头像色板按姓名取稳定色", () => {
    expect(avatarColorOf("林晚晴")).toBe(avatarColorOf("林晚晴"));
    expect(avatarColorOf("")).toBeTruthy();
  });
});
