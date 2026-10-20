import React from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { InpulseApiClient, NotificationPreferences } from "@generated/api";
import { NotificationPolicyPanel } from "./NotificationPolicyPanel";
import { notificationScenarios } from "./settings-content";

function createClient(preferences: NotificationPreferences) {
  let current = preferences;
  const getNotificationPreferences = vi
    .fn()
    .mockImplementation(() => Promise.resolve(current));
  const updateNotificationPreferences = vi
    .fn()
    .mockImplementation((body: NotificationPreferences) => {
      current = body;
      return Promise.resolve(body);
    });
  const issueCsrfToken = vi.fn().mockResolvedValue({ csrfToken: "csrf-1" });
  return {
    client: {
      getNotificationPreferences,
      updateNotificationPreferences,
      issueCsrfToken,
    } as unknown as InpulseApiClient,
    getNotificationPreferences,
    updateNotificationPreferences,
    issueCsrfToken,
  };
}

function renderPanel(client: InpulseApiClient) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <NotificationPolicyPanel client={client} />
    </QueryClientProvider>,
  );
}

describe("NotificationPolicyPanel", () => {
  it("renders every personal notification scenario with a switch from the server policy", async () => {
    const { client } = createClient({ disabledSettings: ["task.complete"] });
    renderPanel(client);
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "接收任务完成提醒" }),
      ).not.toBeChecked(),
    );
    const table = screen.getByRole("table", { name: "通知场景" });
    expect(within(table).getAllByRole("row")).toHaveLength(
      notificationScenarios.length,
    );
    for (const scenario of notificationScenarios) {
      expect(within(table).getByText(scenario.event)).toBeInTheDocument();
      expect(
        within(table).getAllByText(scenario.audience).length,
      ).toBeGreaterThan(0);
    }
  });

  it("saves each change immediately and toggles only the selected type", async () => {
    const { client, updateNotificationPreferences, issueCsrfToken } =
      createClient({ disabledSettings: [] });
    renderPanel(client);
    const target = notificationScenarios[0];
    if (!target) throw new Error("missing scenario");
    const toggle = screen.getByRole("switch", {
      name: "接收" + target.event + "提醒",
    });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);

    await waitFor(() => expect(toggle).not.toBeChecked());
    await waitFor(() =>
      expect(updateNotificationPreferences).toHaveBeenCalledWith(
        { disabledSettings: [target.key] },
        expect.objectContaining({
          headers: expect.objectContaining({
            "x-csrf-token": "csrf-1",
            "Idempotency-Key": expect.any(String),
          }),
        }),
      ),
    );
    expect(issueCsrfToken).toHaveBeenCalledTimes(1);
    const other = notificationScenarios[1];
    if (!other) throw new Error("missing scenario");
    expect(
      screen.getByRole("switch", { name: "接收" + other.event + "提醒" }),
    ).toBeChecked();
  });

  it("reverts the optimistic switch and shows an error when saving fails", async () => {
    const { client, updateNotificationPreferences } = createClient({
      disabledSettings: [],
    });
    updateNotificationPreferences.mockRejectedValueOnce(new Error("offline"));
    renderPanel(client);
    const target = notificationScenarios[0];
    if (!target) throw new Error("missing scenario");
    const toggle = screen.getByRole("switch", {
      name: "接收" + target.event + "提醒",
    });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(
        screen.getByText("通知策略保存失败，请重试。"),
      ).toBeInTheDocument(),
    );
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toBeChecked();
  });
});
