import React from "react";
import { Button } from "antd";
import {
  CalmBadge,
  CalmEmptyState,
  CalmSectionTitle,
} from "@features/common/components/Calm";
import { CalmSkeleton } from "@features/common/components/CalmSkeleton";
import type { InpulseApiClient } from "@generated/api";
import {
  organizationErrorMessage,
  useMyOrganizationMembers,
} from "./organization-query";

export interface MyOrganizationPanelProps {
  readonly client?: InpulseApiClient | undefined;
  readonly currentUserId?: number | undefined;
}

/**
 * ADR-097 普通成员的只读成员视图：自己所属全部组织与去重后的同组织
 * ACTIVE 成员脱敏信息；无组织时归入未分类并说明原因。
 */
export const MyOrganizationPanel: React.FC<MyOrganizationPanelProps> = ({
  client,
  currentUserId,
}) => {
  const query = useMyOrganizationMembers(client);

  if (query.isPending) {
    return (
      <section className="panel settings-panel settings-members-panel">
        <CalmSectionTitle title="成员与角色" />
        <CalmSkeleton variant="list" rows={4} label="正在加载同组织成员" />
      </section>
    );
  }

  if (query.isError) {
    return (
      <section className="panel settings-panel settings-members-panel">
        <CalmSectionTitle title="成员与角色" />
        <CalmEmptyState
          icon="alert"
          title="同组织成员加载失败"
          description={organizationErrorMessage(query.error)}
        >
          <Button
            className="secondary-button"
            onClick={() => void query.refetch()}
          >
            重试
          </Button>
        </CalmEmptyState>
      </section>
    );
  }

  const organizations = query.data.organizations;
  const items = query.data.items;
  const organizationNames = new Map(
    organizations.map((organization) => [organization.id, organization.name]),
  );

  if (organizations.length === 0) {
    return (
      <section className="panel settings-panel settings-members-panel">
        <CalmSectionTitle title="成员与角色" />
        <CalmEmptyState
          icon="users"
          title="当前为未分类"
          description="你还没有组织归属，已归入未分类。本地账号可联系系统管理员分配，SSO 账号请检查 Casdoor 群组配置。"
        />
        <div className="permission-note">
          <span>
            组织用于把成员分组，不影响项目权限；SSO 账号的组织由 Casdoor
            群组自动同步。
          </span>
        </div>
      </section>
    );
  }

  return (
    <section className="panel settings-panel settings-members-panel my-org-panel">
      <CalmSectionTitle title="成员与角色">
        <span className="my-org-count">共 {items.length} 位成员</span>
      </CalmSectionTitle>
      <div className="permission-note">
        {organizations.map((organization) => (
          <CalmBadge
            key={organization.id}
            title={organization.groupPath ?? organization.name}
            tone={organization.source === "CASDOOR" ? "cyan" : "gray"}
          >
            {organization.name}
          </CalmBadge>
        ))}
      </div>
      <div className="member-list">
        {items.map((user) => (
          <div className="member-row" key={user.id}>
            <span className="person-avatar">
              {user.name.trim().charAt(0) || "成"}
            </span>
            <div className="member-id">
              <strong>{user.name}</strong>
            </div>
            <div className="member-meta">
              {currentUserId !== undefined && user.id === currentUserId ? (
                <CalmBadge tone="violet">当前账号</CalmBadge>
              ) : null}
              <CalmBadge tone={user.isAdmin ? "blue" : "gray"}>
                {user.isAdmin ? "系统管理员" : "项目成员"}
              </CalmBadge>
              {user.organizationIds.map((organizationId) => (
                <CalmBadge key={organizationId} tone="cyan">
                  {organizationNames.get(organizationId) ??
                    "组织 " + organizationId}
                </CalmBadge>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};
