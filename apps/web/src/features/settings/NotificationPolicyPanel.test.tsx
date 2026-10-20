import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { NotificationPolicyPanel } from "./NotificationPolicyPanel";
import { notificationScenarios } from "./settings-content";
import { NOTIFICATION_POLICY_STORAGE_KEY } from "./notification-policy-storage";

beforeEach(() => {
  window.localStorage.clear();
});

describe("NotificationPolicyPanel", () => {
  it("renders every personal notification scenario with a switch", () => {
    render(<NotificationPolicyPanel />);
    const table = screen.getByRole("table", { name: "通知场景" });
    expect(within(table).getAllByRole("row")).toHaveLength(
      notificationScenarios.length,
    );
    for (const scenario of notificationScenarios) {
      expect(within(table).getByText(scenario.event)).toBeInTheDocument();
      expect(
        within(table).getAllByText(scenario.audience).length,
      ).toBeGreaterThan(0);
      expect(
        within(table).getByRole("switch", {
          name: "接收" + scenario.event + "提醒",
        }),
      ).toBeChecked();
    }
  });

  it("toggles only the selected notification type", () => {
    render(<NotificationPolicyPanel />);
    const target = notificationScenarios[0];
    if (!target) throw new Error("missing scenario");
    const toggle = screen.getByRole("switch", {
      name: "接收" + target.event + "提醒",
    });
    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    const other = notificationScenarios[1];
    if (!other) throw new Error("missing scenario");
    expect(
      screen.getByRole("switch", { name: "接收" + other.event + "提醒" }),
    ).toBeChecked();
  });

  it("saves each change immediately and restores it for the same account", () => {
    const target = notificationScenarios[0];
    if (!target) throw new Error("missing scenario");
    const name = "接收" + target.event + "提醒";

    const first = render(<NotificationPolicyPanel userId={7} />);
    fireEvent.click(first.getByRole("switch", { name }));
    expect(
      JSON.parse(
        window.localStorage.getItem(NOTIFICATION_POLICY_STORAGE_KEY) ?? "null",
      ),
    ).toEqual({ "7": [target.key] });
    first.unmount();

    const remount = render(<NotificationPolicyPanel userId={7} />);
    expect(remount.getByRole("switch", { name })).not.toBeChecked();
    remount.unmount();

    const otherUser = render(<NotificationPolicyPanel userId={8} />);
    expect(otherUser.getByRole("switch", { name })).toBeChecked();
  });
});
