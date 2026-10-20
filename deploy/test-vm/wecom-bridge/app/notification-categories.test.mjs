import assert from "node:assert/strict";
import test from "node:test";

import {
  flagsFromRow,
  groupCategoryForActivity,
  groupCategoryForNotification,
  groupCategoryIsEnabled,
} from "./notification-categories.mjs";

test("maps current notification and activity types to the five project categories", () => {
  assert.equal(groupCategoryForNotification("task.assigned"), "task.assign");
  assert.equal(
    groupCategoryForNotification("PROJECT_JOINED"),
    "project.member",
  );
  assert.equal(
    groupCategoryForActivity("task.complete", "TASK"),
    "task.status",
  );
  assert.equal(
    groupCategoryForActivity("TASK_DELETED", "TASK"),
    "scope.delete",
  );
  assert.equal(
    groupCategoryForActivity("PROJECT_MEMBER_ADDED", "PROJECT"),
    "project.member",
  );
  assert.equal(
    groupCategoryForActivity("unknown.activity", "CHANGE_RECORD"),
    "record",
  );
});

test("unknown events default to allowed", () => {
  assert.equal(groupCategoryForNotification("future.notification"), null);
  assert.equal(groupCategoryForActivity("future.activity", "UNKNOWN"), null);
  assert.equal(groupCategoryIsEnabled(null, flagsFromRow(null)), true);
});

test("a missing row means all five categories are enabled", () => {
  const flags = flagsFromRow(undefined);
  for (const category of [
    "task.assign",
    "task.status",
    "record",
    "project.member",
    "scope.delete",
  ]) {
    assert.equal(groupCategoryIsEnabled(category, flags), true);
  }
});

test("only an explicit false disables a category", () => {
  const flags = flagsFromRow({
    task_assign_enabled: false,
    task_status_enabled: true,
    record_enabled: true,
    project_member_enabled: true,
    scope_delete_enabled: false,
  });
  assert.equal(groupCategoryIsEnabled("task.assign", flags), false);
  assert.equal(groupCategoryIsEnabled("task.status", flags), true);
  assert.equal(groupCategoryIsEnabled("scope.delete", flags), false);
});
