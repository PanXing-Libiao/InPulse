import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PROJECT_NOTIFICATION_POLICY_CHANGED_EVENT,
  PROJECT_NOTIFICATION_POLICY_STORAGE_KEY,
  type ProjectNotificationCategory,
  readDisabledProjectNotificationTypes,
  readMutedProjectCategoriesQuery,
  subscribeProjectNotificationPolicy,
  writeDisabledProjectNotificationTypes,
} from "./project-notification-policy";

beforeEach(() => {
  window.localStorage.clear();
});

describe("project notification policy", () => {
  it("keeps disabled categories independent per project", () => {
    writeDisabledProjectNotificationTypes(
      12,
      new Set<ProjectNotificationCategory>(["task.assign", "record"]),
    );
    writeDisabledProjectNotificationTypes(
      3,
      new Set<ProjectNotificationCategory>(["task.status"]),
    );

    expect(readDisabledProjectNotificationTypes(12)).toEqual(
      new Set(["task.assign", "record"]),
    );
    expect(readDisabledProjectNotificationTypes(3)).toEqual(
      new Set(["task.status"]),
    );
    expect(readDisabledProjectNotificationTypes(9)).toEqual(new Set());
  });

  it("serializes muted categories by ascending project id", () => {
    writeDisabledProjectNotificationTypes(
      12,
      new Set<ProjectNotificationCategory>(["task.assign", "record"]),
    );
    writeDisabledProjectNotificationTypes(
      3,
      new Set<ProjectNotificationCategory>(["task.status"]),
    );

    expect(readMutedProjectCategoriesQuery()).toBe(
      "3:task.status,12:task.assign,12:record",
    );

    writeDisabledProjectNotificationTypes(
      3,
      new Set<ProjectNotificationCategory>(),
    );
    writeDisabledProjectNotificationTypes(
      12,
      new Set<ProjectNotificationCategory>(),
    );
    expect(readMutedProjectCategoriesQuery()).toBeUndefined();
  });

  it("notifies same-page subscribers and reacts to other-tab storage events", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeProjectNotificationPolicy(listener);

    writeDisabledProjectNotificationTypes(
      5,
      new Set<ProjectNotificationCategory>(["record"]),
    );
    expect(listener).toHaveBeenCalledTimes(1);

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: PROJECT_NOTIFICATION_POLICY_STORAGE_KEY,
      }),
    );
    expect(listener).toHaveBeenCalledTimes(2);

    window.dispatchEvent(
      new StorageEvent("storage", { key: "inpulse.other-preference" }),
    );
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    writeDisabledProjectNotificationTypes(
      5,
      new Set<ProjectNotificationCategory>(),
    );
    window.dispatchEvent(new Event(PROJECT_NOTIFICATION_POLICY_CHANGED_EVENT));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("ignores malformed storage data", () => {
    window.localStorage.setItem(
      PROJECT_NOTIFICATION_POLICY_STORAGE_KEY,
      JSON.stringify({ "12": ["unknown"], bad: ["record"], "0": ["record"] }),
    );

    expect(readDisabledProjectNotificationTypes(12)).toEqual(new Set());
    expect(readMutedProjectCategoriesQuery()).toBeUndefined();
  });
});
