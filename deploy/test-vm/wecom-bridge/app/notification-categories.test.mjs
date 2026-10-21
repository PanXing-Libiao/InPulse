import assert from "node:assert/strict";
import test from "node:test";

import {
  flagsFromRow,
  groupActivityDisposition,
  groupCategoryIsEnabled,
} from "./notification-categories.mjs";

function category(activityType, metadata) {
  return groupActivityDisposition(activityType, metadata).category;
}

test("maps task creation and real assignment changes to task.assign", () => {
  assert.equal(category("task.create", undefined), "task.assign");
  assert.equal(
    category("task.update", { assignmentChanged: true }),
    "task.assign",
  );
  assert.deepEqual(groupActivityDisposition("TASK.CREATE", undefined), {
    category: "task.assign",
    skip: false,
  });
});

test("skips ordinary task edits that do not change assignees", () => {
  assert.deepEqual(
    groupActivityDisposition("task.update", { assignmentChanged: false }),
    { category: null, skip: true },
  );
  assert.deepEqual(groupActivityDisposition("task.update", undefined), {
    category: null,
    skip: true,
  });
  assert.deepEqual(groupActivityDisposition("task.update", {}), {
    category: null,
    skip: true,
  });
});

test("maps current task, record, project and deletion activities", () => {
  for (const activityType of [
    "task.complete",
    "task.reopen",
    "task.cancel",
    "task.restore",
    "task.merge",
    "task.unmerge",
  ]) {
    assert.equal(category(activityType, undefined), "task.status");
  }
  for (const activityType of [
    "record.publish",
    "record.version.create",
    "record.leftover.add",
    "leftover.convert",
    "CHANGE_RECORD_RESTORED",
  ]) {
    assert.equal(category(activityType, undefined), "record");
  }
  for (const activityType of [
    "PROJECT_CREATED",
    "PROJECT_UPDATED",
    "PROJECT_STATUS_CHANGED",
    "PROJECT_MEMBER_ADDED",
    "PROJECT_MEMBER_REMOVED",
    "PROJECT_MEMBER_ROLE_CHANGED",
    "EXTERNAL_LINK_ADDED",
    "EXTERNAL_LINK_REMOVED",
    "module.create",
    "module.update",
    "feature.create",
    "feature.update",
  ]) {
    assert.equal(category(activityType, undefined), "project.member");
  }
  for (const activityType of [
    "TASK_DELETED",
    "MODULE_DELETED",
    "FEATURE_DELETED",
  ]) {
    assert.equal(category(activityType, undefined), "scope.delete");
  }
});

test("unknown activities remain allowed without guessing an entity category", () => {
  assert.deepEqual(groupActivityDisposition("future.activity", undefined), {
    category: null,
    skip: false,
  });
  assert.equal(groupCategoryIsEnabled(null, flagsFromRow(null)), true);
});

test("a missing row means all five categories are enabled", () => {
  const flags = flagsFromRow(undefined);
  for (const categoryName of [
    "task.assign",
    "task.status",
    "record",
    "project.member",
    "scope.delete",
  ]) {
    assert.equal(groupCategoryIsEnabled(categoryName, flags), true);
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
