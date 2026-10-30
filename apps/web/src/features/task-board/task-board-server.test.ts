import { describe, expect, it, vi } from "vitest";
import type { InpulseApiClient, TaskBoardResponse } from "@generated/api";

import {
  createTaskBoardServerAdapter,
  TASK_BOARD_SERVER_NOTICE,
} from "./task-board-server";

const response: TaskBoardResponse = {
  project: { projectId: 7, name: "支付中心", status: "ACTIVE" },
  generatedAt: "2026-09-17T06:20:00.000Z",
  stats: {
    total: 42,
    done: 27,
    open: 12,
    canceled: 3,
    overdue: 3,
    dueToday: 2,
    completedThisWeek: 5,
    completionRate: 69,
    memberCount: 4,
  },
  modules: [],
  truncated: false,
};

describe("task board server adapter", () => {
  it("经生成客户端请求 R-8 聚合读接口并原样返回结果", async () => {
    const getProjectTaskBoard = vi.fn().mockResolvedValue(response);
    const client = { getProjectTaskBoard } as unknown as InpulseApiClient;

    const adapter = createTaskBoardServerAdapter(client);

    expect(adapter.source).toBe("server");
    expect(adapter.notice).toBe(TASK_BOARD_SERVER_NOTICE);
    await expect(adapter.fetchTaskBoard({ projectId: 7 })).resolves.toBe(
      response,
    );
    expect(getProjectTaskBoard).toHaveBeenCalledWith(7);
  });

  it("把接口错误原样抛给页面，不吞掉 404/401 语义", async () => {
    const failure = new Error("请求失败");
    const getProjectTaskBoard = vi.fn().mockRejectedValue(failure);
    const client = { getProjectTaskBoard } as unknown as InpulseApiClient;

    const adapter = createTaskBoardServerAdapter(client);

    await expect(adapter.fetchTaskBoard({ projectId: 9 })).rejects.toBe(
      failure,
    );
  });
});
