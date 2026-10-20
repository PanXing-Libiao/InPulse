import { describe, expect, it } from "vitest";
import { parseTaskDetailPath, taskDetailPath } from "./task-links";

describe("task-links", () => {
  it("解析模块级任务通知深链", () => {
    expect(
      parseTaskDetailPath("/projects/12/modules/34/tasks?taskId=56"),
    ).toEqual({
      projectId: 12,
      moduleId: 34,
      featureId: null,
      taskId: 56,
    });
  });

  it("解析功能级任务通知深链", () => {
    expect(
      parseTaskDetailPath(
        "/projects/12/modules/34/features/78?taskId=56&from=notification",
      ),
    ).toEqual({
      projectId: 12,
      moduleId: 34,
      featureId: 78,
      taskId: 56,
    });
  });

  it("与 taskDetailPath 往返一致", () => {
    const moduleTask = {
      projectId: 3,
      moduleId: 9,
      featureId: null,
      taskId: 27,
    };
    const featureTask = {
      projectId: 3,
      moduleId: 9,
      featureId: 15,
      taskId: 27,
    };
    expect(parseTaskDetailPath(taskDetailPath(moduleTask))).toEqual(moduleTask);
    expect(parseTaskDetailPath(taskDetailPath(featureTask))).toEqual(
      featureTask,
    );
  });

  it("忽略非任务地址、缺少 taskId 与外部地址", () => {
    expect(parseTaskDetailPath("/projects/12/activity")).toBeNull();
    expect(parseTaskDetailPath("/projects/12/modules/34/tasks")).toBeNull();
    expect(
      parseTaskDetailPath(
        "https://example.com/projects/12/modules/34/tasks?taskId=56",
      ),
    ).toBeNull();
    expect(
      parseTaskDetailPath("/projects/12/modules/34/tasks?taskId=abc"),
    ).toBeNull();
  });
});
