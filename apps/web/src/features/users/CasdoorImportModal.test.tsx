import React from "react";
import { ConfigProvider } from "antd";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type {
  CasdoorImportPreviewResponse,
  CasdoorImportResult,
  InpulseApiClient,
} from "@generated/api";

import { CasdoorImportModal } from "./CasdoorImportModal";

const preview: CasdoorImportPreviewResponse = {
  organization: "libiaorobot.com",
  fetchedAt: "2026-10-27T00:00:00.000Z",
  scannedUserCount: 2,
  items: [
    {
      casdoorId: "create-1",
      loginName: "new-user",
      displayName: "新成员",
      email: "new-user@libiaorobot.com",
      groups: ["libiaorobot.com/测试部"],
      action: "create",
      reason: null,
    },
    {
      casdoorId: "skip-1",
      loginName: "conflict",
      displayName: "冲突成员",
      email: "conflict@libiaorobot.com",
      groups: [],
      action: "skip",
      reason: "email-mismatch",
    },
  ],
  counts: { create: 1, link: 0, refresh: 0, skip: 1 },
};

const imported: CasdoorImportResult = {
  scannedUserCount: 1,
  created: 1,
  linked: 0,
  refreshed: 0,
  skipped: 0,
  createdOrganizationCount: 1,
  membershipCount: 1,
};

function ui(
  client: InpulseApiClient,
  open: boolean,
  onImported: (result: CasdoorImportResult) => void,
  onClose: () => void,
) {
  return (
    <ConfigProvider theme={{ token: { motion: false } }}>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <CasdoorImportModal
          open={open}
          client={client}
          onClose={onClose}
          onImported={onImported}
        />
      </QueryClientProvider>
    </ConfigProvider>
  );
}

describe("CasdoorImportModal", () => {
  it("默认全选可导入账号，展示实体组与冲突原因，确认后携带 CSRF 和幂等键", async () => {
    const previewCasdoorUserImport = vi.fn().mockResolvedValue(preview);
    const issueCsrfToken = vi.fn().mockResolvedValue({ csrfToken: "csrf-1" });
    const importCasdoorUsers = vi.fn().mockResolvedValue(imported);
    const onImported = vi.fn();
    const onClose = vi.fn();
    const client = {
      previewCasdoorUserImport,
      issueCsrfToken,
      importCasdoorUsers,
    } as unknown as InpulseApiClient;

    render(ui(client, true, onImported, onClose));

    expect(await screen.findByText("新成员")).toBeInTheDocument();
    expect(screen.getByText("测试部")).toBeInTheDocument();
    expect(screen.queryByText("Virtual Group1")).not.toBeInTheDocument();
    expect(screen.getByText("登录名相同但邮箱不一致")).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "全选可导入账号" }),
    ).toBeChecked();
    expect(screen.getByText("已选 1 个")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "导入 1 个账号" }));

    await waitFor(() => expect(onImported).toHaveBeenCalledWith(imported));
    expect(issueCsrfToken).toHaveBeenCalledTimes(1);
    expect(importCasdoorUsers).toHaveBeenCalledWith(
      { casdoorUserIds: ["create-1"] },
      {
        headers: expect.objectContaining({
          "x-csrf-token": "csrf-1",
          "Idempotency-Key": expect.stringMatching(/^casdoor-import-/),
        }),
      },
    );
  });

  it("取消选择后禁用确认，重新打开会刷新目录", async () => {
    const previewCasdoorUserImport = vi.fn().mockResolvedValue(preview);
    const client = {
      previewCasdoorUserImport,
      issueCsrfToken: vi.fn(),
      importCasdoorUsers: vi.fn(),
    } as unknown as InpulseApiClient;
    const onImported = vi.fn();
    const onClose = vi.fn();
    const view = render(ui(client, true, onImported, onClose));

    await screen.findByText("新成员");
    fireEvent.click(screen.getByRole("checkbox", { name: "全选可导入账号" }));
    expect(screen.getByText("已选 0 个")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "导入 0 个账号" }),
    ).toBeDisabled();

    view.rerender(ui(client, false, onImported, onClose));
    view.rerender(ui(client, true, onImported, onClose));

    await waitFor(() =>
      expect(previewCasdoorUserImport).toHaveBeenCalledTimes(2),
    );
  });
});
