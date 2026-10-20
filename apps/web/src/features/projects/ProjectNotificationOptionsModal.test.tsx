import { ConfigProvider } from "antd";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ProjectNotificationOptionsModal,
  projectNotificationOptions,
} from "./ProjectNotificationOptionsModal";

function mount(onClose: () => void = () => undefined) {
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <ProjectNotificationOptionsModal open onClose={onClose} />
    </ConfigProvider>,
  );
  return screen.getByRole("dialog", { name: "通知选项" });
}

describe("ProjectNotificationOptionsModal", () => {
  it("shows the project name as the header eyebrow", () => {
    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <ProjectNotificationOptionsModal
          open
          projectName="智慧园区访客管理平台"
          onClose={() => undefined}
        />
      </ConfigProvider>,
    );
    const dialog = screen.getByRole("dialog", { name: "通知选项" });

    expect(
      within(dialog).getByText("智慧园区访客管理平台"),
    ).toBeInTheDocument();
  });

  it("renders every project group notification option enabled by default", () => {
    const dialog = mount();

    for (const option of projectNotificationOptions) {
      expect(within(dialog).getByText(option.event)).toBeInTheDocument();
      expect(
        within(dialog).getByRole("switch", {
          name: "项目群推送" + option.event,
        }),
      ).toBeChecked();
    }
  });

  it("toggles only the selected option", () => {
    const dialog = mount();
    const first = projectNotificationOptions[0];
    const second = projectNotificationOptions[1];
    if (!first || !second) throw new Error("missing option");

    fireEvent.click(
      within(dialog).getByRole("switch", {
        name: "项目群推送" + first.event,
      }),
    );

    expect(
      within(dialog).getByRole("switch", {
        name: "项目群推送" + first.event,
      }),
    ).not.toBeChecked();
    expect(
      within(dialog).getByRole("switch", {
        name: "项目群推送" + second.event,
      }),
    ).toBeChecked();
  });

  it("closes from the 完成 button", () => {
    const onClose = vi.fn();
    const dialog = mount(onClose);

    fireEvent.click(within(dialog).getByRole("button", { name: /完\s*成/ }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
