import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type {
  CurrentUserResponse,
  InpulseApiClient,
  ModuleItem,
} from "@generated/api";
import { AuthStateProvider } from "@features/auth/auth-context";
import { ProjectTree } from "./ProjectTree";
import type { TreeScope } from "./tree-selection";

/**
 * 手风琴回归：同一时刻只铺开一个项目的子级。
 * 装配一个会随导航更新 activeScope 的壳，模拟真实路由，
 * 否则 ProjectTree 看不到「当前项目」的变化。
 */

const projects = [
  { id: 2, code: "AGV", name: "AGV 智能搬运平台", status: "ACTIVE" },
  { id: 9, code: "WMS", name: "WMS 仓储管理", status: "ACTIVE" },
];

const moduleItem = {
  id: 3,
  name: "调度模块",
  status: "ACTIVE",
} as unknown as ModuleItem;

const signedInUser: CurrentUserResponse = {
  id: 7,
  loginName: "viewer",
  name: "查看者",
  email: null,
  avatarUrl: null,
  isAdmin: false,
  status: "ACTIVE",
};

const TestAuthProvider: React.FC<{ readonly children: React.ReactNode }> = ({
  children,
}) => (
  <AuthStateProvider value={{ status: "authenticated", user: signedInUser }}>
    {children}
  </AuthStateProvider>
);

function createClient() {
  return {
    listProjects: vi.fn().mockResolvedValue({ items: projects }),
    getProject: vi.fn().mockResolvedValue({ project: projects[0] }),
    listModules: vi.fn().mockResolvedValue({ items: [moduleItem] }),
  } as unknown as InpulseApiClient;
}

const RoutedTree: React.FC<{ readonly client: InpulseApiClient }> = ({
  client,
}) => {
  const [scope, setScope] = useState<TreeScope | null>(null);
  const onNavigate = (path: string) => {
    const match = /^\/projects\/(\d+)\/modules/.exec(path);
    if (match) {
      setScope({ projectId: Number(match[1]), selection: { kind: "project" } });
    }
  };
  return (
    <ProjectTree activeScope={scope} onNavigate={onNavigate} client={client} />
  );
};

const mount = (client: InpulseApiClient) =>
  render(
    <TestAuthProvider>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <RoutedTree client={client} />
      </QueryClientProvider>
    </TestAuthProvider>,
  );

describe("ProjectTree 手风琴", () => {
  it("展开另一个项目时收起当前项目的子级", async () => {
    mount(createClient());

    const agv = await screen.findByRole("button", { name: /AGV 智能搬运平台/ });
    const wms = screen.getByRole("button", { name: /WMS 仓储管理/ });

    // 项目列表页（没有当前项目）默认整棵树收起。
    expect(agv).toHaveAttribute("aria-expanded", "false");
    expect(wms).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(agv);
    expect(agv).toHaveAttribute("aria-expanded", "true");
    expect(wms).toHaveAttribute("aria-expanded", "false");
    // 只铺开一个项目的子页行。
    expect(
      await screen.findAllByRole("button", { name: "项目与模块" }),
    ).toHaveLength(1);

    fireEvent.click(wms);
    expect(wms).toHaveAttribute("aria-expanded", "true");
    expect(agv).toHaveAttribute("aria-expanded", "false");
    // 前一个项目的子页行与模块列表一起消失，仍只剩一份。
    expect(screen.queryByRole("button", { name: /调度模块/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: "项目与模块" })).toHaveLength(
      1,
    );
  });
});
