import { ConfigProvider } from "antd";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectWecomGroupNotificationOptions } from "@generated/api";
import { readDisabledProjectNotificationTypes } from "@shared/notifications/project-notification-policy";
import {
  ProjectNotificationOptionsModal,
  projectNotificationOptions,
} from "./ProjectNotificationOptionsModal";

const allEnabled: ProjectWecomGroupNotificationOptions = {
  disabledCategories: [],
};

function mount(options: {
  readonly notificationOptions?: ProjectWecomGroupNotificationOptions;
  readonly projectName?: string;
  readonly onSave?: (
    value: ProjectWecomGroupNotificationOptions,
  ) => Promise<void>;
  readonly onClose?: () => void;
}) {
  const onSave = options.onSave ?? vi.fn().mockResolvedValue(undefined);
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <ProjectNotificationOptionsModal
        open
        projectId={7}
        projectName={options.projectName}
        options={options.notificationOptions ?? allEnabled}
        onSave={onSave}
        saveErrorMessage={() => "保存失败，请重试。"}
        onClose={options.onClose ?? (() => undefined)}
      />
    </ConfigProvider>,
  );
  return {
    dialog: screen.getByRole("dialog", { name: "通知选项" }),
    onSave,
  };
}

describe("ProjectNotificationOptionsModal", () => {
  beforeEach(() => localStorage.clear());

  it("shows the project name as the header eyebrow", () => {
    const { dialog } = mount({ projectName: "智慧园区访客管理平台" });

    expect(
      within(dialog).getByText("智慧园区访客管理平台"),
    ).toBeInTheDocument();
  });

  it("renders every project group notification option enabled by default", () => {
    const { dialog } = mount({});

    for (const option of projectNotificationOptions) {
      expect(within(dialog).getByText(option.event)).toBeInTheDocument();
      expect(
        within(dialog).getByRole("switch", {
          name: "项目群推送" + option.event,
        }),
      ).toBeChecked();
    }
  });

  it("restores disabled categories from the server status", () => {
    const { dialog } = mount({
      notificationOptions: { disabledCategories: ["task.assign"] },
    });
    const first = projectNotificationOptions[0];
    const second = projectNotificationOptions[1];
    if (!first || !second) throw new Error("missing option");

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

  it("saves the complete disabled list immediately after a toggle", async () => {
    const { dialog, onSave } = mount({
      notificationOptions: { disabledCategories: ["record"] },
    });
    const first = projectNotificationOptions[0];
    if (!first) throw new Error("missing option");

    fireEvent.click(
      within(dialog).getByRole("switch", {
        name: "项目群推送" + first.event,
      }),
    );

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        disabledCategories: ["record", "task.assign"],
      }),
    );
    expect(readDisabledProjectNotificationTypes(7)).toEqual(
      new Set(["record", "task.assign"]),
    );
    expect(
      within(dialog).getByText(/机器人会按新规则处理后续群消息/),
    ).toBeInTheDocument();
  });

  it("disables switches while the server save is pending", async () => {
    let finishSave: (() => void) | undefined;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    const { dialog } = mount({ onSave });
    const first = projectNotificationOptions[0];
    if (!first) throw new Error("missing option");
    const switchButton = within(dialog).getByRole("switch", {
      name: "项目群推送" + first.event,
    });

    fireEvent.click(switchButton);

    await waitFor(() => expect(switchButton).toBeDisabled());
    expect(
      within(dialog).getByRole("button", { name: /正在保存/ }),
    ).toBeInTheDocument();
    finishSave?.();
    await waitFor(() => expect(switchButton).not.toBeDisabled());
  });

  it("rolls back the switch and shows the save error when the server rejects", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("forbidden"));
    const { dialog } = mount({ onSave });
    const first = projectNotificationOptions[0];
    if (!first) throw new Error("missing option");
    const switchButton = within(dialog).getByRole("switch", {
      name: "项目群推送" + first.event,
    });

    fireEvent.click(switchButton);

    expect(
      await within(dialog).findByText("保存失败，请重试。"),
    ).toBeInTheDocument();
    expect(switchButton).toBeChecked();
  });

  it("explains how group and in-site notification filtering are separated", () => {
    const { dialog } = mount({});

    expect(within(dialog).getByText(/控制企业微信群消息/)).toBeInTheDocument();
    expect(
      within(dialog).getByText(/当前浏览器的站内通知/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/各自的个人通知设置管理/),
    ).toBeInTheDocument();
  });

  it("keeps the saved confirmation when refreshed server options arrive while open", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const first = projectNotificationOptions[0];
    if (!first) throw new Error("missing option");
    const view = (options: ProjectWecomGroupNotificationOptions) => (
      <ConfigProvider theme={{ token: { motion: false } }}>
        <ProjectNotificationOptionsModal
          open
          projectId={7}
          options={options}
          onSave={onSave}
          saveErrorMessage={() => "保存失败，请重试。"}
          onClose={() => undefined}
        />
      </ConfigProvider>
    );
    const { rerender } = render(view(allEnabled));

    fireEvent.click(
      screen.getByRole("switch", {
        name: "项目群推送" + first.event,
      }),
    );
    expect(
      await screen.findByText(/机器人会按新规则处理后续群消息/),
    ).toBeInTheDocument();

    rerender(view({ disabledCategories: ["task.assign"] }));

    expect(
      screen.getByText(/机器人会按新规则处理后续群消息/),
    ).toBeInTheDocument();
  });

  it("closes from the 完成 button", () => {
    const onClose = vi.fn();
    const { dialog } = mount({ onClose });

    fireEvent.click(within(dialog).getByRole("button", { name: /完\s*成/ }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
