import React, { useMemo, useRef, useState } from "react";
import { Alert, Button, Checkbox, Input, Space, Switch } from "antd";
import { AppModal as Modal } from "@features/common/components/AppModal";
import { Controller, useForm } from "react-hook-form";
import {
  ApiError,
  type AdminUserItem,
  type InpulseApiClient,
} from "@generated/api";
import {
  CalmBadge,
  CalmEmptyState,
  CalmSectionTitle,
  CalmSegmented,
} from "@features/common/components/Calm";
import { InpulseIcon } from "@features/common/components/InpulseIcon";
import { AiAssistSettingsPanel } from "@features/settings/AiAssistSettingsPanel";
import { WecomRobotSettingsPanel } from "@features/settings/WecomRobotSettingsPanel";
import { NotificationPolicyPanel } from "@features/settings/NotificationPolicyPanel";
import { PermissionMatrixPanel } from "@features/settings/PermissionMatrixPanel";
import { adminUserErrorMessage, useAdminUsers } from "./admin-user-query";
import { MyOrganizationPanel } from "./MyOrganizationPanel";
import { OrganizationManagerModal } from "./OrganizationManagerModal";
import {
  organizationErrorMessage,
  useOrganizationMutations,
  useOrganizations,
} from "./organization-query";
import { CalmSkeleton } from "@features/common/components/CalmSkeleton";

type LifecycleAction = "disable" | "enable" | "forceLogout" | "delete";
type MemberScope = "active" | "departed";

/** 设计师稿 latest-version/views/settings.tsx L9-11：左栏区块导航。 */
export type SettingsTab =
  "members" | "permissions" | "notifications" | "aiAssist" | "wecomRobot";

type EditorValues = {
  readonly name: string;
  readonly email: string;
  readonly isAdmin: boolean;
};

interface MemberGroup {
  readonly organizationId: number | null;
  readonly members: readonly AdminUserItem[];
}

/**
 * ADR-081：同组织成员放在同一分组，组间按「当前账号所在组织置顶、
 * 其余组织 id 升序、未分配最后」排列；组内保持调用方传入的顺序。
 */
function groupMembersByOrganization(
  members: readonly AdminUserItem[],
  selfOrganizationId: number | null,
): readonly MemberGroup[] {
  const groups = new Map<number | null, AdminUserItem[]>();
  const order: (number | null)[] = [];
  for (const user of members) {
    const key = user.organizationId ?? null;
    const bucket = groups.get(key);
    if (bucket === undefined) {
      groups.set(key, [user]);
      order.push(key);
    } else {
      bucket.push(user);
    }
  }
  const rank = (key: number | null) => {
    if (selfOrganizationId !== null && key === selfOrganizationId) return 0;
    if (key === null) return 2;
    return 1;
  };
  order.sort((left, right) => {
    const diff = rank(left) - rank(right);
    if (diff !== 0) return diff;
    if (left === null || right === null) return 0;
    return left - right;
  });
  return order.map((key) => ({
    organizationId: key,
    members: groups.get(key) ?? [],
  }));
}

const lifecycleCopy: Readonly<
  Record<LifecycleAction, { title: string; description: string }>
> = {
  disable: {
    title: "停用用户",
    description: "停用后将撤销该用户全部会话并记录审计；历史数据不会删除。",
  },
  enable: {
    title: "启用用户",
    description: "启用后用户可重新登录；历史与已撤销会话不会恢复。",
  },
  forceLogout: {
    title: "强制退出",
    description: "将立即撤销该用户全部会话并记录审计，账号保持启用状态。",
  },
  delete: {
    title: "强制删除",
    description:
      "删除不可撤销：账号会被墓碑化，登录名与个人资料清除，历史业务记录中的显示名改为「删除用户」。原始审计快照保持不可变。",
  },
};

export const AdminUsersPageView: React.FC<AdminUsersPageViewProps> = ({
  client,
  currentUserId,
  onOpenProjects,
  initialTab,
  isAdmin = false,
}) => {
  const { query, mutation } = useAdminUsers(client, { enabled: isAdmin });
  const [editor, setEditor] = useState<AdminUserItem | null>(null);
  const [lifecycle, setLifecycle] = useState<{
    action: LifecycleAction;
    user: AdminUserItem;
  } | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>(
    initialTab ?? "members",
  );
  const [memberSearch, setMemberSearch] = useState("");
  const [memberScope, setMemberScope] = useState<MemberScope>("active");
  const submitting = useRef(false);
  const organizations = useOrganizations(client, { enabled: isAdmin });
  const organizationMutation = useOrganizationMutations(client);
  const [selectedUserIds, setSelectedUserIds] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const [assignDialog, setAssignDialog] = useState<null | {
    readonly mode: "join" | "remove";
  }>(null);
  const [organizationManagerOpen, setOrganizationManagerOpen] = useState(false);
  const [batchMode, setBatchMode] = useState(false);
  const {
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<EditorValues>({
    defaultValues: { name: "", email: "", isAdmin: false },
  });

  const openUpdate = (user: AdminUserItem) => {
    setEditor(user);
    setLifecycle(null);
    setSuccess(null);
    setFormError(null);
    setReloadError(null);
    mutation.reset();
    reset({
      name: user.name,
      email: user.email ?? "",
      isAdmin: user.isAdmin,
    });
  };

  const openLifecycle = (action: LifecycleAction, user: AdminUserItem) => {
    setEditor(null);
    setLifecycle({ action, user });
    setSuccess(null);
    setFormError(null);
    setReloadError(null);
    mutation.reset();
  };

  const closeEditor = () => {
    if (submitting.current) return;
    setEditor(null);
    setFormError(null);
    setReloadError(null);
    mutation.reset();
  };

  const closeLifecycle = () => {
    if (submitting.current) return;
    setLifecycle(null);
    mutation.reset();
  };

  const save = handleSubmit(async (values) => {
    if (!editor || submitting.current) return;
    submitting.current = true;
    setFormError(null);
    try {
      const body: {
        name?: string;
        email?: string | null;
        isAdmin?: boolean;
      } = {};
      const name = values.name.trim();
      const email = values.email.trim();
      if (name !== editor.name) body.name = name;
      if (email !== (editor.email ?? ""))
        body.email = email.length === 0 ? null : email;
      if (values.isAdmin !== editor.isAdmin) body.isAdmin = values.isAdmin;
      if (Object.keys(body).length === 0) {
        setFormError("没有需要保存的更改。");
        return;
      }
      await mutation.mutateAsync({ action: "update", user: editor, body });
      setSuccess("用户资料已更新");
      setEditor(null);
      reset();
    } catch {
      // 失败详情由 mutation 状态统一渲染，避免重复提示。
    } finally {
      submitting.current = false;
    }
  });

  const reloadLatest = async () => {
    if (!editor || reloading) return;
    setReloading(true);
    setReloadError(null);
    try {
      const result = await query.refetch();
      if (result.error) {
        setReloadError(adminUserErrorMessage(result.error));
        return;
      }
      const latest = result.data?.items.find((item) => item.id === editor.id);
      if (!latest) {
        setReloadError("用户已不存在，请关闭编辑窗口。");
        return;
      }
      reset({
        name: latest.name,
        email: latest.email ?? "",
        isAdmin: latest.isAdmin,
      });
      setEditor(latest);
      mutation.reset();
      setFormError(null);
    } finally {
      setReloading(false);
    }
  };

  const confirmLifecycle = async () => {
    if (!lifecycle || submitting.current) return;
    submitting.current = true;
    try {
      await mutation.mutateAsync({
        action: lifecycle.action,
        user: lifecycle.user,
      });
      setSuccess(
        lifecycle.action === "disable"
          ? "用户已停用"
          : lifecycle.action === "enable"
            ? "用户已启用"
            : lifecycle.action === "delete"
              ? "账号已强制删除，历史业务记录中的显示名已改为「删除用户」"
              : "已强制退出该用户",
      );
      setLifecycle(null);
    } catch {
      // 失败详情由 mutation 状态统一渲染，避免重复提示。
    } finally {
      submitting.current = false;
    }
  };

  const versionConflict =
    mutation.error instanceof ApiError &&
    mutation.error.code === "ADMIN_USER_VERSION_CONFLICT";
  const selfAdmin = (user: AdminUserItem) =>
    currentUserId !== undefined && user.id === currentUserId;

  const selfIsAdmin = isAdmin;

  // 非管理员不展示管理员专属页签；深链命中时回退到成员页。
  const effectiveTab: SettingsTab =
    (activeTab === "aiAssist" || activeTab === "wecomRobot") && !selfIsAdmin
      ? "members"
      : activeTab;

  // 当前登录账号置顶（便于先确认自身身份与权限），其后是其他系统管理员，最后是普通成员；同组内保持服务端顺序。
  // 墓碑账号不再属于成员管理范围：即使旧缓存仍返回，也同时在启用与已停用筛选中隐藏。
  const allMembers = useMemo(() => {
    const items = (query.data?.items ?? []).filter(
      (user) => user.deletedAt === null,
    );
    const rank = (user: AdminUserItem) => {
      if (currentUserId !== undefined && user.id === currentUserId) return 0;
      return user.isAdmin ? 1 : 2;
    };
    return [...items].sort((left, right) => rank(left) - rank(right));
  }, [query.data, currentUserId]);

  const activeMembers = useMemo(
    () =>
      allMembers.filter(
        (user) => user.status === "ACTIVE" && user.deletedAt === null,
      ),
    [allMembers],
  );
  const departedMembers = useMemo(
    () => allMembers.filter((user) => user.status === "DISABLED"),
    [allMembers],
  );
  const scopedMembers =
    memberScope === "active" ? activeMembers : departedMembers;

  // 本地搜索（2026-10-16 用户指示）：按姓名、登录名或邮箱筛选当前成员列表，不走全局搜索。
  const memberKeyword = memberSearch.trim().toLocaleLowerCase();
  const visibleMembers =
    memberKeyword === ""
      ? scopedMembers
      : scopedMembers.filter(
          (user) =>
            user.name.toLocaleLowerCase().includes(memberKeyword) ||
            user.loginName.toLocaleLowerCase().includes(memberKeyword) ||
            (user.email ?? "").toLocaleLowerCase().includes(memberKeyword),
        );

  const organizationName = (organizationId: number | null | undefined) => {
    if (organizationId === null || organizationId === undefined) {
      return "未分配";
    }
    return (
      organizations.data?.items.find((item) => item.id === organizationId)
        ?.name ?? "组织 " + organizationId
    );
  };

  const selfOrganizationId =
    activeMembers.find((user) => user.id === currentUserId)?.organizationId ??
    null;
  const memberGroups = groupMembersByOrganization(
    visibleMembers,
    selfOrganizationId,
  );

  const switchMemberScope = (next: MemberScope) => {
    setMemberScope(next);
    setBatchMode(false);
    setSelectedUserIds(new Set());
    setAssignDialog(null);
    setSuccess(null);
  };

  const toggleUserSelection = (userId: number, checked: boolean) => {
    setSelectedUserIds((current) => {
      const next = new Set(current);
      if (checked) next.add(userId);
      else next.delete(userId);
      return next;
    });
  };

  const allVisibleSelected =
    visibleMembers.length > 0 &&
    visibleMembers.every((user) => selectedUserIds.has(user.id));
  const someVisibleSelected = visibleMembers.some((user) =>
    selectedUserIds.has(user.id),
  );

  const toggleAllVisible = (checked: boolean) => {
    setSelectedUserIds((current) => {
      const next = new Set(current);
      for (const user of visibleMembers) {
        if (checked) next.add(user.id);
        else next.delete(user.id);
      }
      return next;
    });
  };

  const assignSelectedTo = async (
    organizationId: number | null,
    successText: string,
  ) => {
    if (selectedUserIds.size === 0) return;
    const userIds = [...selectedUserIds];
    try {
      await organizationMutation.mutateAsync({
        action: "assign",
        userIds,
        organizationId,
      });
      setSuccess(successText);
      setSelectedUserIds(new Set());
      setAssignDialog(null);
    } catch {
      // 失败详情由 organizationMutation.error 统一渲染。
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1>成员与设置</h1>
        </div>
        <span className="identity-chip">
          当前身份：{selfIsAdmin ? "系统管理员" : "项目成员"}
        </span>
      </div>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="成员与设置导航">
          <button
            type="button"
            className={effectiveTab === "members" ? "selected" : undefined}
            aria-current={effectiveTab === "members" ? "page" : undefined}
            onClick={() => setActiveTab("members")}
          >
            <InpulseIcon name="users" size={15} />
            成员与角色
          </button>
          {onOpenProjects ? (
            <button type="button" onClick={onOpenProjects}>
              <InpulseIcon name="folder" size={15} />
              项目成员
            </button>
          ) : null}
          <button
            type="button"
            className={effectiveTab === "permissions" ? "selected" : undefined}
            aria-current={effectiveTab === "permissions" ? "page" : undefined}
            onClick={() => setActiveTab("permissions")}
          >
            <InpulseIcon name="shield" size={15} />
            权限矩阵
          </button>
          <button
            type="button"
            className={
              effectiveTab === "notifications" ? "selected" : undefined
            }
            aria-current={effectiveTab === "notifications" ? "page" : undefined}
            onClick={() => setActiveTab("notifications")}
          >
            <InpulseIcon name="bell" size={15} />
            通知策略
          </button>
          {selfIsAdmin ? (
            <button
              type="button"
              className={effectiveTab === "aiAssist" ? "selected" : undefined}
              aria-current={effectiveTab === "aiAssist" ? "page" : undefined}
              onClick={() => setActiveTab("aiAssist")}
            >
              <InpulseIcon name="zap" size={15} />
              AI 辅助转换
            </button>
          ) : null}
          {selfIsAdmin ? (
            <button
              type="button"
              className={effectiveTab === "wecomRobot" ? "selected" : undefined}
              aria-current={effectiveTab === "wecomRobot" ? "page" : undefined}
              onClick={() => setActiveTab("wecomRobot")}
            >
              <InpulseIcon name="settings" size={15} />
              企业微信机器人
            </button>
          ) : null}
        </nav>

        {effectiveTab === "permissions" ? <PermissionMatrixPanel /> : null}
        {effectiveTab === "notifications" ? <NotificationPolicyPanel /> : null}
        {effectiveTab === "aiAssist" ? (
          <AiAssistSettingsPanel {...(client ? { client } : {})} />
        ) : null}
        {effectiveTab === "wecomRobot" ? (
          <WecomRobotSettingsPanel {...(client ? { client } : {})} />
        ) : null}

        {effectiveTab === "members" && !isAdmin ? (
          <MyOrganizationPanel client={client} currentUserId={currentUserId} />
        ) : null}

        {effectiveTab === "members" && isAdmin ? (
          <section className="panel settings-panel">
            <CalmSectionTitle
              title="成员与角色"
              hint={
                query.data
                  ? `启用 ${activeMembers.length} 位 · 已停用/离职 ${departedMembers.length} 位`
                  : "正在加载成员列表"
              }
            >
              {scopedMembers.length > 0 ? (
                <div className="task-search">
                  <InpulseIcon name="search" size={15} />
                  <input
                    aria-label="搜索成员"
                    placeholder="搜索姓名、登录名或邮箱"
                    value={memberSearch}
                    onChange={(event) => setMemberSearch(event.target.value)}
                  />
                </div>
              ) : null}
            </CalmSectionTitle>

            <div className="member-scope-filter">
              <CalmSegmented
                label="成员状态筛选"
                value={memberScope}
                options={[
                  {
                    value: "active",
                    label: "启用",
                    count: activeMembers.length,
                  },
                  {
                    value: "departed",
                    label: "已停用/离职",
                    count: departedMembers.length,
                  },
                ]}
                onChange={switchMemberScope}
              />
            </div>

            <div className="member-toolbar">
              {batchMode ? (
                <>
                  <Checkbox
                    indeterminate={!allVisibleSelected && someVisibleSelected}
                    checked={allVisibleSelected}
                    onChange={(event) => toggleAllVisible(event.target.checked)}
                  >
                    全选当前结果
                  </Checkbox>
                  <span className="member-toolbar-info">
                    {selectedUserIds.size > 0
                      ? "已选 " + selectedUserIds.size + " 人"
                      : "勾选成员后可批量加入或移出组织"}
                  </span>
                  <span className="member-toolbar-actions">
                    <Button
                      className="secondary-button"
                      disabled={selectedUserIds.size === 0}
                      onClick={() => setAssignDialog({ mode: "join" })}
                    >
                      加入组织
                    </Button>
                    <Button
                      className="secondary-button"
                      disabled={selectedUserIds.size === 0}
                      onClick={() => setAssignDialog({ mode: "remove" })}
                    >
                      移出组织
                    </Button>
                    <Button
                      className="text-button"
                      disabled={selectedUserIds.size === 0}
                      onClick={() => setSelectedUserIds(new Set())}
                    >
                      清空选择
                    </Button>
                    <Button
                      className="secondary-button"
                      onClick={() => {
                        setBatchMode(false);
                        setSelectedUserIds(new Set());
                      }}
                    >
                      退出批量
                    </Button>
                  </span>
                </>
              ) : (
                <>
                  <span className="member-toolbar-info">
                    {memberScope === "active"
                      ? "需要把多名启用成员加入或移出组织时，进入批量管理勾选成员。"
                      : "已停用/离职账号不参与批量组织调整；如需调整组织，请先启用账号并回到「启用」页签。"}
                  </span>
                  <span className="member-toolbar-actions">
                    {memberScope === "active" ? (
                      <Button
                        className="secondary-button"
                        onClick={() => setBatchMode(true)}
                      >
                        批量管理
                      </Button>
                    ) : null}
                    <Button
                      className="secondary-button"
                      onClick={() => setOrganizationManagerOpen(true)}
                    >
                      组织管理
                    </Button>
                  </span>
                </>
              )}
            </div>

            {success ? (
              <div className="permission-note note-success" role="status">
                <InpulseIcon name="check" size={16} />
                <span>{success}</span>
              </div>
            ) : null}

            {query.isPending ? (
              <CalmSkeleton variant="list" rows={5} label="正在加载用户列表" />
            ) : query.isError ? (
              <CalmEmptyState
                icon="alert"
                title="用户列表加载失败"
                description={adminUserErrorMessage(query.error)}
              >
                <Button
                  className="secondary-button"
                  onClick={() => void query.refetch()}
                >
                  重试
                </Button>
              </CalmEmptyState>
            ) : !allMembers.length ? (
              <CalmEmptyState
                icon="users"
                title="暂无用户"
                description="账号由统一身份认证在首次登录时自动创建，无需在此新增。"
              />
            ) : !scopedMembers.length ? (
              <CalmEmptyState
                icon="users"
                title={
                  memberScope === "active"
                    ? "暂无启用成员"
                    : "暂无已停用/离职账号"
                }
                description={
                  memberScope === "active"
                    ? "已停用或已删除的账号可在「已停用/离职」页签查看。"
                    : "停用账号会出现在这里；删除后仍保留墓碑记录用于历史归属。"
                }
              />
            ) : !visibleMembers.length ? (
              <CalmEmptyState
                icon="search"
                title="没有匹配的成员"
                description="调整关键词后重试，或清空搜索查看全部成员。"
              >
                <Button
                  className="secondary-button"
                  onClick={() => setMemberSearch("")}
                >
                  清空搜索
                </Button>
              </CalmEmptyState>
            ) : (
              <div className="member-list">
                {memberGroups.map((group) => (
                  <React.Fragment key={group.organizationId ?? "unassigned"}>
                    <div className="member-group-title">
                      {organizationName(group.organizationId)} ·{" "}
                      {group.members.length} 人
                    </div>
                    {group.members.map((user) => (
                      <div
                        className={
                          "member-row" +
                          (batchMode ? " is-selectable" : "") +
                          (user.deletedAt === null ? "" : " is-deleted")
                        }
                        key={user.id}
                      >
                        {batchMode ? (
                          <Checkbox
                            aria-label={"选择 " + user.name}
                            checked={selectedUserIds.has(user.id)}
                            onChange={(event) =>
                              toggleUserSelection(user.id, event.target.checked)
                            }
                          />
                        ) : null}
                        <span className="person-avatar">
                          {user.deletedAt === null
                            ? user.name.trim().charAt(0) || "成"
                            : "删"}
                        </span>
                        <div className="member-id">
                          <strong>
                            {user.deletedAt === null ? user.name : "删除用户"}
                            {user.deletedAt === null ? null : (
                              <span className="member-self">（已删除）</span>
                            )}
                            {selfAdmin(user) ? (
                              <span className="member-self">（当前账号）</span>
                            ) : null}
                          </strong>
                          <small>
                            {user.deletedAt === null
                              ? user.loginName +
                                (user.email ? " · " + user.email : "")
                              : "账号 #" + user.id + " · 历史归属保留"}
                          </small>
                        </div>
                        <div className="member-meta">
                          {user.deletedAt === null ? (
                            <>
                              <CalmBadge tone={user.isAdmin ? "blue" : "gray"}>
                                {user.isAdmin ? "系统管理员" : "项目成员"}
                              </CalmBadge>
                              <CalmBadge
                                tone={
                                  user.organizationId === null ||
                                  user.organizationId === undefined
                                    ? "gray"
                                    : "cyan"
                                }
                              >
                                {organizationName(user.organizationId)}
                              </CalmBadge>
                            </>
                          ) : (
                            <CalmBadge tone="gray">已删除账号</CalmBadge>
                          )}
                          <span
                            className={
                              "member-status" +
                              (user.deletedAt === null
                                ? user.status === "ACTIVE"
                                  ? ""
                                  : " is-disabled"
                                : " is-deleted")
                            }
                          >
                            {user.deletedAt === null
                              ? user.status === "ACTIVE"
                                ? "启用"
                                : "停用"
                              : "已删除"}
                          </span>
                        </div>
                        <div className="member-actions">
                          {user.deletedAt === null ? (
                            <>
                              <Button
                                className="text-button"
                                onClick={() => openUpdate(user)}
                              >
                                编辑
                              </Button>
                              {!selfAdmin(user) && (
                                <Button
                                  className="text-button"
                                  onClick={() =>
                                    openLifecycle(
                                      user.status === "ACTIVE"
                                        ? "disable"
                                        : "enable",
                                      user,
                                    )
                                  }
                                >
                                  {user.status === "ACTIVE" ? "停用" : "启用"}
                                </Button>
                              )}
                              {!selfAdmin(user) && user.status === "ACTIVE" && (
                                <Button
                                  className="text-button"
                                  onClick={() =>
                                    openLifecycle("forceLogout", user)
                                  }
                                >
                                  强制退出
                                </Button>
                              )}
                              {!selfAdmin(user) &&
                              user.status === "DISABLED" ? (
                                <Button
                                  className="text-button"
                                  danger
                                  onClick={() => openLifecycle("delete", user)}
                                >
                                  强制删除
                                </Button>
                              ) : null}
                            </>
                          ) : (
                            <span className="member-actions-note">
                              仅保留历史归属
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </React.Fragment>
                ))}
              </div>
            )}

            <div className="permission-note">
              <InpulseIcon name="shield" size={16} />
              <span>
                <strong>权限提示</strong>
                系统管理员与项目组长可以删除项目（物理删除且不可撤销）、作废与恢复记录、查看原始审计快照；高风险操作需要二次确认。项目成员在已加入项目内拥有全部普通研发操作权限。
              </span>
            </div>
          </section>
        ) : null}
      </div>

      <Modal
        className="catalog-modal"
        open={editor !== null}
        eyebrow={editor ? "账号 · " + editor.loginName : "用户目录与本地账号"}
        title="编辑用户"
        body
        onCancel={closeEditor}
        mask={{ closable: !mutation.isPending }}
      >
        <form
          className="admin-user-form"
          onSubmit={(event) => void save(event)}
        >
          <p>
            账号由统一身份认证创建，登录名不可修改；编辑资料、邮箱与管理员角色都会写入审计。
          </p>
          <label htmlFor="admin-user-name">姓名</label>
          <Controller
            name="name"
            control={control}
            rules={{
              validate: (value) => value.trim().length > 0 || "请填写姓名",
              maxLength: { value: 200, message: "姓名最多 200 字" },
            }}
            render={({ field }) => (
              <Input
                {...field}
                id="admin-user-name"
                disabled={mutation.isPending || reloading}
              />
            )}
          />
          <p role="alert">{errors.name?.message}</p>
          <label htmlFor="admin-user-email">邮箱</label>
          <Controller
            name="email"
            control={control}
            rules={{ maxLength: { value: 320, message: "邮箱最多 320 字" } }}
            render={({ field }) => (
              <Input
                {...field}
                id="admin-user-email"
                disabled={mutation.isPending || reloading}
                placeholder="可选"
              />
            )}
          />
          <p role="alert">{errors.email?.message}</p>
          <label>管理员角色</label>
          <Controller
            name="isAdmin"
            control={control}
            render={({ field }) => (
              <Switch
                {...field}
                aria-label="管理员角色"
                checked={field.value}
                disabled={
                  mutation.isPending ||
                  reloading ||
                  (editor !== null && selfAdmin(editor))
                }
                onChange={field.onChange}
              />
            )}
          />
          <p>
            {editor !== null && selfAdmin(editor)
              ? "不能取消自己当前的管理员角色。"
              : "开启后该账号可执行用户管理与项目删除等管理员操作。"}
          </p>
          {formError && <Alert type="error" title={formError} />}
          {mutation.isError && (
            <Alert type="error" title={adminUserErrorMessage(mutation.error)} />
          )}
          {reloadError && <Alert type="error" title={reloadError} />}
          {versionConflict && (
            <Button loading={reloading} onClick={() => void reloadLatest()}>
              加载最新版本后继续编辑
            </Button>
          )}
          <Space style={{ marginTop: 16 }}>
            <Button onClick={closeEditor} disabled={mutation.isPending}>
              取消
            </Button>
            <Button
              type="primary"
              htmlType="submit"
              loading={mutation.isPending}
              disabled={reloading || !!versionConflict}
            >
              保存
            </Button>
          </Space>
        </form>
      </Modal>

      <Modal
        className="catalog-modal"
        open={lifecycle !== null}
        eyebrow={
          lifecycle ? "账号 · " + lifecycle.user.loginName : "账号生命周期"
        }
        title={lifecycle ? lifecycleCopy[lifecycle.action].title : ""}
        // 停用与强制删除是破坏性动作（红）、强制退出是告警（橙）、启用是挽回（绿）。
        tone={
          lifecycle !== null && lifecycle.action === "enable"
            ? "success"
            : lifecycle !== null && lifecycle.action === "forceLogout"
              ? "warning"
              : "danger"
        }
        icon={
          lifecycle === null ||
          lifecycle.action === "disable" ||
          lifecycle.action === "delete"
            ? "alert"
            : lifecycle.action === "forceLogout"
              ? "logout"
              : "check"
        }
        body
        onCancel={closeLifecycle}
        mask={{ closable: !mutation.isPending }}
      >
        {lifecycle && (
          <>
            <p>{lifecycleCopy[lifecycle.action].description}</p>
            <p>
              目标用户：{lifecycle.user.name}（{lifecycle.user.loginName}）
            </p>
            {mutation.isError && (
              <Alert
                type="error"
                title={adminUserErrorMessage(mutation.error)}
              />
            )}
            <Space style={{ marginTop: 16 }}>
              <Button onClick={closeLifecycle} disabled={mutation.isPending}>
                取消
              </Button>
              <Button
                type="primary"
                danger={
                  lifecycle.action === "disable" ||
                  lifecycle.action === "delete"
                }
                loading={mutation.isPending}
                onClick={() => void confirmLifecycle()}
              >
                {lifecycle.action === "delete" ? "确认删除" : "确认"}
              </Button>
            </Space>
          </>
        )}
      </Modal>

      <Modal
        className="catalog-modal"
        open={assignDialog !== null}
        eyebrow="批量调整组织"
        title={assignDialog?.mode === "join" ? "加入组织" : "移出组织"}
        body
        onCancel={() => setAssignDialog(null)}
        mask={{ closable: !organizationMutation.isPending }}
      >
        {assignDialog?.mode === "join" ? (
          <>
            <p>把已选 {selectedUserIds.size} 名成员加入：</p>
            {(organizations.data?.items ?? []).length === 0 ? (
              <p>还没有组织，先到「组织管理」里创建。</p>
            ) : (
              <div className="organization-pick-list">
                {(organizations.data?.items ?? []).map((item) => (
                  <Button
                    key={item.id}
                    className="secondary-button"
                    disabled={organizationMutation.isPending}
                    onClick={() =>
                      void assignSelectedTo(
                        item.id,
                        "已把 " +
                          selectedUserIds.size +
                          " 名成员加入「" +
                          item.name +
                          "」",
                      )
                    }
                  >
                    {item.name}
                  </Button>
                ))}
              </div>
            )}
          </>
        ) : (
          <p>
            将已选 {selectedUserIds.size}{" "}
            名成员移出所在组织（变为未分配），操作立即生效。
          </p>
        )}
        {organizationMutation.isError ? (
          <Alert
            type="error"
            title={organizationErrorMessage(organizationMutation.error)}
          />
        ) : null}
        <Space style={{ marginTop: 16 }}>
          {assignDialog?.mode === "remove" ? (
            <Button
              type="primary"
              loading={organizationMutation.isPending}
              onClick={() =>
                void assignSelectedTo(
                  null,
                  "已把 " + selectedUserIds.size + " 名成员移出组织",
                )
              }
            >
              确认移出
            </Button>
          ) : null}
          <Button
            onClick={() => setAssignDialog(null)}
            disabled={organizationMutation.isPending}
          >
            取消
          </Button>
        </Space>
      </Modal>

      <OrganizationManagerModal
        open={organizationManagerOpen}
        onClose={() => setOrganizationManagerOpen(false)}
        members={activeMembers}
        client={client}
        onChanged={(message) => setSuccess(message)}
      />
    </>
  );
};

export interface AdminUsersPageViewProps {
  readonly client?: InpulseApiClient | undefined;
  readonly currentUserId?: number | undefined;
  readonly onOpenProjects?: (() => void) | undefined;
  readonly initialTab?: SettingsTab | undefined;
  readonly isAdmin?: boolean | undefined;
}
