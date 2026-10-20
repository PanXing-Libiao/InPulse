import { ConfigProvider } from "antd";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ProjectNotificationOptionsModal,
  projectNotificationOptions,
} from "./ProjectNotificationOptionsModal";
import { PROJECT_NOTIFICATION_POLICY_STORAGE_KEY } from "@shared/notifications/project-notification-policy";

function mount(onClose: () => void = () => undefined, projectId: number = 7) {
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <ProjectNotificationOptionsModal
        open
        projectId={projectId}
        onClose={onClose}
      />
    </ConfigProvider>,
  );
  return screen.getByRole("dialog", { name: "通知选项" });
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("ProjectNotificationOptionsModal", () => {
  it("shows the project name as the header eyebrow", () => {
    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <ProjectNotificationOptionsModal
          open
          projectId={7}
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

  it("saves each change immediately and restores it for the same project", () => {
    const first = projectNotificationOptions[0];
    if (!first) throw new Error("missing option");
    const name = "项目群推送" + first.event;

    const firstView = render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <ProjectNotificationOptionsModal
          open
          projectId={7}
          onClose={() => undefined}
        />
      </ConfigProvider>,
    );
    fireEvent.click(screen.getByRole("switch", { name }));
    expect(
      JSON.parse(
        window.localStorage.getItem(PROJECT_NOTIFICATION_POLICY_STORAGE_KEY) ??
          "null",
      ),
    ).toEqual({ "7": [first.key] });
    firstView.unmount();

    const sameProject = mount(undefined, 7);
    expect(within(sameProject).getByRole("switch", { name })).not.toBeChecked();
    sameProject.remove();

    const otherProject = mount(undefined, 8);
    expect(within(otherProject).getByRole("switch", { name })).toBeChecked();
  });

  it("explains that disabled categories also hide in-site notifications", () => {
    const dialog = mount();

    expect(
      within(dialog).getByText(/站内通知列表和未读计数/),
    ).toBeInTheDocument();
  });

  it("closes from the 完成 button", () => {
    const onClose = vi.fn();
    const dialog = mount(onClose);

    fireEvent.click(within(dialog).getByRole("button", { name: /完\s*成/ }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
