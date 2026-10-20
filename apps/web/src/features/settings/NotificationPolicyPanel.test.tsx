import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NotificationPolicyPanel } from "./NotificationPolicyPanel";
import { notificationScenarios } from "./settings-content";

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
});
