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
 * ADR-081 普通成员的只读成员视图：自己所属组织与同组织 ACTIVE 成员的
 * 脱敏信息（姓名、头像、是否管理员）；未分配时说明原因。
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

  const organization = query.data.organization;
  const items = query.data.items;

  if (organization === null) {
    return (
      <section className="panel settings-panel settings-members-panel">
        <CalmSectionTitle title="成员与角色" />
        <CalmEmptyState
          icon="users"
          title="尚未加入组织"
          description="你还没有被分配组织，联系系统管理员分配后即可看到同组织成员。"
        />
        <div className="permission-note">
          <span>
            组织用于把成员分组，不影响项目权限；成员列表由系统管理员维护。
          </span>
        </div>
      </section>
    );
  }

  return (
    <section className="panel settings-panel settings-members-panel">
      <CalmSectionTitle title="成员与角色" />
      <div className="member-list">
        {items.map((user) => (
          <div className="member-row" key={user.id}>
            <span className="person-avatar">
              {user.name.trim().charAt(0) || "成"}
            </span>
            <div className="member-id">
              <strong>{user.name}</strong>
              <small>{organization.name}</small>
            </div>
            <div className="member-meta">
              {currentUserId !== undefined && user.id === currentUserId ? (
                <CalmBadge tone="violet">当前账号</CalmBadge>
              ) : null}
              <CalmBadge tone={user.isAdmin ? "blue" : "gray"}>
                {user.isAdmin ? "系统管理员" : "项目成员"}
              </CalmBadge>
            </div>
          </div>
        ))}
      </div>
      <div className="permission-note">
        <span>
          只读视图：仅展示同组织成员的姓名、头像与角色；调整组织归属请联系系统管理员。
        </span>
      </div>
    </section>
  );
};
