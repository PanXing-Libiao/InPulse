import React, { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Checkbox, Input, Space, Switch } from "antd";
import { AppModal as Modal } from "@features/common/components/AppModal";
import { Controller, useForm } from "react-hook-form";
import {
  ApiError,
  type AdminUserDisableRequest,
  type AdminUserItem,
  type InpulseApiClient,
} from "@generated/api";
import {
  CalmBadge,
  CalmEmptyState,
  CalmSectionTitle,
  CalmSegmented,
} from "@features/common/components/Calm";
import { CalmSelect } from "@features/common/components/CalmSelect";
import { InpulseIcon } from "@features/common/components/InpulseIcon";
import { AiAssistSettingsPanel } from "@features/settings/AiAssistSettingsPanel";
import { WecomRobotSettingsPanel } from "@features/settings/WecomRobotSettingsPanel";
import { NotificationPolicyPanel } from "@features/settings/NotificationPolicyPanel";
import { PermissionMatrixPanel } from "@features/settings/PermissionMatrixPanel";
import { adminUserErrorMessage, useAdminUsers } from "./admin-user-query";
import { DisableAccountModal } from "./DisableAccountModal";
import { MyOrganizationPanel } from "./MyOrganizationPanel";
import {
  organizationErrorMessage,
  useOrganizationMutations,
  useOrganizations,
} from "./organization-query";
import { CalmSkeleton } from "@features/common/components/CalmSkeleton";

type LifecycleAction = "enable" | "delete";
type MemberScope = "active" | "departed";

/** 设计师稿 latest-version/views/settings.tsx L9-11：左栏区块导航。 */
export type SettingsTab =
  "members" | "permissions" | "notifications" | "aiAssist" | "wecomRobot";

type EditorValues = {
  readonly name: string;
  readonly email: string;
  readonly isAdmin: boolean;
};

type OrgView = "all" | "admins" | number;

type OrgMode = "browse" | "join" | "manage";

const lifecycleCopy: Readonly<
  Record<LifecycleAction, { title: string; description: string }>
> = {
  enable: {
    title: "启用用户",
    description: "启用后用户可重新登录；历史与已撤销会话不会恢复。",
  },
  delete: {
    title: "强制删除",
    description:
      "删除不可撤销：账号及个人会话、TOTP、通知与企业微信绑定会被永久删除；项目、任务、迭代记录、审计和项目动态保留事件当时姓名。",
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
  const [disableTarget, setDisableTarget] = useState<AdminUserItem | null>(
    null,
  );
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
  const [orgView, setOrgView] = useState<OrgView>("all");
  const [orgMode, setOrgMode] = useState<OrgMode>("browse");
  const [orgTarget, setOrgTarget] = useState<number | null>(null);
  const [joinTarget, setJoinTarget] = useState("");
  const [newOrganizationName, setNewOrganizationName] = useState("");
  const [orgRenameDraft, setOrgRenameDraft] = useState("");
  const [selectedUserIds, setSelectedUserIds] = useState<readonly number[]>([]);
  const organizationMutation = useOrganizationMutations(client);
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
    setDisableTarget(null);
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
    setDisableTarget(null);
    setLifecycle({ action, user });
    setSuccess(null);
    setFormError(null);
    setReloadError(null);
    mutation.reset();
  };

  const openDisable = (user: AdminUserItem) => {
    setEditor(null);
    setLifecycle(null);
    setDisableTarget(user);
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

  const closeDisable = () => {
    if (mutation.isPending) return;
    setDisableTarget(null);
    mutation.reset();
  };

  const confirmDisable = async (body: AdminUserDisableRequest) => {
    if (disableTarget === null || mutation.isPending) return;
    await mutation.mutateAsync({
      action: "disable",
      user: disableTarget,
      body,
    });
    setSuccess("用户已停用");
    setDisableTarget(null);
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
        lifecycle.action === "enable"
          ? "用户已启用"
          : "账号已删除，审计与项目动态保留事件当时姓名",
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

  // 成员排序：当前账号置顶，其后未分配组织、已分配组织；是否停用由上方
  // 「启用中 / 已停用」筛选分桶，不再把两类账号混排在同一列表。
  const members = useMemo(() => {
    const items = (query.data?.items ?? []).filter(
      (user) => user.deletedAt === null,
    );
    const rank = (user: AdminUserItem) => {
      if (user.status !== "ACTIVE") return 100;
      if (currentUserId !== undefined && user.id === currentUserId) return 0;
      const organizationRank = (user.organizationId ?? null) === null ? 0 : 1;
      return 10 + organizationRank * 10 + (user.isAdmin ? 0 : 1);
    };
    return [...items].sort((left, right) => rank(left) - rank(right));
  }, [query.data, currentUserId]);

  const activeMembers = useMemo(
    () => members.filter((user) => user.status === "ACTIVE"),
    [members],
  );
  const departedMembers = useMemo(
    () => members.filter((user) => user.status === "DISABLED"),
    [members],
  );
  const scopedMembers =
    memberScope === "active" ? activeMembers : departedMembers;

  const memberKeyword = memberSearch.trim().toLocaleLowerCase();
  const matchesKeyword = (user: AdminUserItem) =>
    memberKeyword === "" ||
    user.name.toLocaleLowerCase().includes(memberKeyword) ||
    user.loginName.toLocaleLowerCase().includes(memberKeyword) ||
    (user.email ?? "").toLocaleLowerCase().includes(memberKeyword);
  // 组织管理期间只处理启用账号：停用账号不能参与组织调整，也不在管理列表里占位。
  const manageableMembers =
    orgMode === "browse"
      ? scopedMembers
      : scopedMembers.filter((user) => user.status === "ACTIVE");
  const baseMembers =
    orgMode === "join"
      ? manageableMembers.filter(
          (user) => (user.organizationId ?? null) === null,
        )
      : orgView === "admins"
        ? manageableMembers.filter((user) => user.isAdmin)
        : typeof orgView === "number"
          ? manageableMembers.filter((user) => user.organizationId === orgView)
          : manageableMembers;
  const visibleMembers = baseMembers.filter(matchesKeyword);

  const countByOrganization = (organizationId: number | null) =>
    scopedMembers.filter(
      (user) => (user.organizationId ?? null) === organizationId,
    ).length;
  const joinOrganizationOptions = useMemo(
    () => [
      ...(organizations.data?.items ?? [])
        .filter((organization) =>
          scopedMembers.some(
            (user) => (user.organizationId ?? null) === organization.id,
          ),
        )
        .map((organization) => ({
          value: String(organization.id),
          label: organization.name,
        })),
      { value: "new", label: "＋ 新建组织" },
    ],
    [organizations.data, scopedMembers],
  );

  const adminCount = scopedMembers.filter((user) => user.isAdmin).length;

  const canSelectMember = (user: AdminUserItem) =>
    user.status === "ACTIVE" &&
    ((orgMode === "join" && (user.organizationId ?? null) === null) ||
      (orgMode === "manage" && user.organizationId === orgTarget));

  const toggleUserSelection = (userId: number, checked: boolean) => {
    setSelectedUserIds((current) =>
      checked ? [...current, userId] : current.filter((id) => id !== userId),
    );
  };

  const organizationName = (organizationId: number | null | undefined) => {
    if (organizationId === null || organizationId === undefined) {
      return "未分配";
    }
    return (
      organizations.data?.items.find((item) => item.id === organizationId)
        ?.name ?? "组织 " + organizationId
    );
  };

  const switchOrgView = (view: OrgView) => {
    setOrgView(view);
    setOrgMode("browse");
    setOrgTarget(null);
    setJoinTarget("");
    setNewOrganizationName("");
    setOrgRenameDraft("");
    setSelectedUserIds([]);
  };

  const resetOrgMode = () => {
    setOrgMode("browse");
    setOrgTarget(null);
    setJoinTarget("");
    setNewOrganizationName("");
    setOrgRenameDraft("");
    setSelectedUserIds([]);
  };

  const switchMemberScope = (next: MemberScope) => {
    if (next === memberScope) return;
    setMemberScope(next);
    setOrgView("all");
    resetOrgMode();
    setSuccess(null);
  };

  const openOrganizationBatch = () => {
    setOrgMode("join");
    setOrgTarget(null);
    setJoinTarget("");
    setNewOrganizationName("");
    setOrgView("all");
    setSelectedUserIds([]);
    setSuccess(null);
  };

  const handleOrgAction = () => {
    if (orgMode !== "browse") {
      closeOrganizationBatch();
      return;
    }
    if (typeof orgView === "number") {
      openManage(orgView);
      return;
    }
    openOrganizationBatch();
  };

  const closeOrganizationBatch = () => {
    resetOrgMode();
  };

  // 组织最后一名成员被移出后，对应标签会消失；若它正被查看或管理，自动回到「全部」，
  // 避免停在一个没有任何标签可返回的空列表上。
  useEffect(() => {
    if (typeof orgView !== "number" || organizations.data === undefined) return;
    if (scopedMembers.some((user) => user.organizationId === orgView)) return;
    setOrgView("all");
    setOrgMode("browse");
    setOrgTarget(null);
    setSelectedUserIds([]);
  }, [orgView, scopedMembers, organizations.data]);

  const openManage = (organizationId: number) => {
    setOrgMode("manage");
    setOrgTarget(organizationId);
    setOrgView(organizationId);
    setJoinTarget("");
    setNewOrganizationName("");
    setOrgRenameDraft(
      organizations.data?.items.find((item) => item.id === organizationId)
        ?.name ?? "",
    );
    setSelectedUserIds([]);
    setSuccess(null);
  };

  const refreshMemberData = async () => {
    await query.refetch();
    await organizations.refetch();
  };

  const joinSelected = async () => {
    if (selectedUserIds.length === 0) {
      setSuccess("请先勾选未分配的成员。");
      return;
    }
    try {
      let organizationId = joinTarget === "" ? null : Number(joinTarget);
      let targetName = "";
      if (joinTarget === "new") {
        const name = newOrganizationName.trim();
        if (name === "") {
          setSuccess("请先填写新组织名称。");
          return;
        }
        const created = (await organizationMutation.mutateAsync({
          action: "create",
          name,
        })) as { readonly id?: number } | undefined;
        if (created === undefined || typeof created.id !== "number") {
          setSuccess("组织已创建，但未能加入成员，请刷新后重试。");
          return;
        }
        organizationId = created.id;
        targetName = name;
      }
      if (organizationId === null) {
        setSuccess("请先选择目标组织。");
        return;
      }
      await organizationMutation.mutateAsync({
        action: "assign",
        userIds: selectedUserIds,
        organizationId,
      });
      setSuccess(
        "已把 " +
          selectedUserIds.length +
          " 名成员加入「" +
          (targetName !== "" ? targetName : organizationName(organizationId)) +
          "」",
      );
      resetOrgMode();
      await refreshMemberData();
    } catch (error) {
      setSuccess(organizationErrorMessage(error));
    }
  };

  const leaveSelected = async () => {
    if (selectedUserIds.length === 0) {
      setSuccess("请先勾选成员。");
      return;
    }
    try {
      await organizationMutation.mutateAsync({
        action: "assign",
        userIds: selectedUserIds,
        organizationId: null,
      });
      setSuccess(
        "已把 " + selectedUserIds.length + " 名成员移出，变为未分配。",
      );
      resetOrgMode();
      await refreshMemberData();
    } catch (error) {
      setSuccess(organizationErrorMessage(error));
    }
  };

  const renameOrganization = async () => {
    if (orgTarget === null) return;
    const organization = organizations.data?.items.find(
      (item) => item.id === orgTarget,
    );
    if (!organization) {
      setSuccess("组织不存在，或已被删除。");
      return;
    }
    const name = orgRenameDraft.trim();
    if (name === "") {
      setSuccess("请填写组织名称。");
      return;
    }
    if (name === organization.name) {
      setSuccess("组织名称没有变化。");
      return;
    }
    setSuccess(null);
    try {
      await organizationMutation.mutateAsync({
        action: "rename",
        organization,
        name,
      });
      setOrgRenameDraft(name);
      await refreshMemberData();
    } catch (error) {
      setSuccess(organizationErrorMessage(error));
    }
  };

  let orgActionLabel = "加入组织";
  if (typeof orgView === "number") orgActionLabel = "编辑组织";
  if (orgMode !== "browse") orgActionLabel = "退出调整";

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
        {effectiveTab === "notifications" ? (
          <NotificationPolicyPanel userId={currentUserId} />
        ) : null}
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
          <section className="panel settings-panel settings-members-panel">
            <CalmSectionTitle title="成员与角色">
              <div className="member-head-tools">
                <div className="member-scope-filter">
                  <CalmSegmented
                    label="成员状态筛选"
                    value={memberScope}
                    options={[
                      {
                        value: "active",
                        label: "启用中",
                        count: activeMembers.length,
                      },
                      {
                        value: "departed",
                        label: "已停用",
                        count: departedMembers.length,
                      },
                    ]}
                    onChange={switchMemberScope}
                  />
                </div>
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
                {memberScope === "active" ? (
                  <Button
                    className="secondary-button"
                    aria-expanded={orgMode !== "browse"}
                    onClick={handleOrgAction}
                  >
                    {orgActionLabel}
                  </Button>
                ) : null}
              </div>
            </CalmSectionTitle>

            {memberScope === "active" ? (
              <div className="member-org-bar">
                <div
                  className="member-org-tabs"
                  role="tablist"
                  aria-label="按组织筛选成员"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={orgView === "all"}
                    className={
                      "member-org-tab" + (orgView === "all" ? " is-active" : "")
                    }
                    onClick={() => switchOrgView("all")}
                  >
                    全部 <b>{scopedMembers.length}</b>
                  </button>
                  {adminCount > 0 ? (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={orgView === "admins"}
                      className={
                        "member-org-tab" +
                        (orgView === "admins" ? " is-active" : "")
                      }
                      onClick={() => switchOrgView("admins")}
                    >
                      系统管理员 <b>{adminCount}</b>
                    </button>
                  ) : null}
                  {(organizations.data?.items ?? [])
                    .filter(
                      (organization) =>
                        countByOrganization(organization.id) > 0,
                    )
                    .map((organization) => (
                      <button
                        key={organization.id}
                        type="button"
                        role="tab"
                        aria-selected={orgView === organization.id}
                        className={
                          "member-org-tab" +
                          (orgView === organization.id ? " is-active" : "")
                        }
                        onClick={() => switchOrgView(organization.id)}
                      >
                        {organization.name}{" "}
                        <b>{countByOrganization(organization.id)}</b>
                      </button>
                    ))}
                </div>
              </div>
            ) : null}

            {orgMode === "manage" && typeof orgTarget === "number" ? (
              <div className="member-rename-bar">
                <label htmlFor="member-org-rename">组织名称</label>
                <input
                  id="member-org-rename"
                  value={orgRenameDraft}
                  maxLength={80}
                  placeholder="填写组织名称"
                  onChange={(event) => setOrgRenameDraft(event.target.value)}
                />
                <Button
                  className="secondary-button"
                  disabled={
                    organizationMutation.isPending ||
                    orgRenameDraft.trim() === "" ||
                    orgRenameDraft.trim() === organizationName(orgTarget)
                  }
                  onClick={() => void renameOrganization()}
                >
                  保存名称
                </Button>
              </div>
            ) : null}

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
            ) : !members.length ? (
              <CalmEmptyState
                icon="users"
                title="暂无用户"
                description="账号由统一身份认证在首次登录时自动创建，无需在此新增。"
              />
            ) : !scopedMembers.length ? (
              <CalmEmptyState
                icon="users"
                title={
                  memberScope === "active" ? "暂无启用成员" : "暂无已停用成员"
                }
                description={
                  memberScope === "active"
                    ? "当前没有启用中的成员账号。"
                    : "停用账号会显示在这里，可重新启用或强制删除。"
                }
              />
            ) : !visibleMembers.length ? (
              <CalmEmptyState
                icon="search"
                title="没有匹配的成员"
                description={
                  orgMode === "join"
                    ? "当前没有未分配的启用账号。"
                    : orgMode === "manage"
                      ? "该组织没有可管理的启用成员。"
                      : memberScope === "departed"
                        ? "调整搜索关键词后重试。"
                        : "调整关键词或切换组织标签后重试。"
                }
              >
                {memberSearch.trim().length > 0 ? (
                  <Button
                    className="secondary-button"
                    onClick={() => setMemberSearch("")}
                  >
                    清空搜索
                  </Button>
                ) : null}
              </CalmEmptyState>
            ) : (
              <div className="member-list admin-member-list">
                {visibleMembers.map((user) => (
                  <div
                    className={
                      "member-row" +
                      (orgMode !== "browse" ? " is-selectable" : "") +
                      (user.status === "ACTIVE" ? "" : " is-disabled")
                    }
                    key={user.id}
                  >
                    {orgMode !== "browse" ? (
                      canSelectMember(user) ? (
                        <Checkbox
                          aria-label={"选择 " + user.name}
                          checked={selectedUserIds.includes(user.id)}
                          onChange={(event) =>
                            toggleUserSelection(user.id, event.target.checked)
                          }
                        />
                      ) : (
                        <span className="member-check-placeholder" />
                      )
                    ) : null}
                    <span className="person-avatar">
                      {user.name.trim().charAt(0) || "成"}
                    </span>
                    <div className="member-id">
                      <strong>{user.name}</strong>
                      <small>
                        {user.loginName}
                        {user.email ? " · " + user.email : ""}
                      </small>
                    </div>
                    <div className="member-meta">
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
                      <span
                        className={
                          "member-status" +
                          (user.status === "ACTIVE" ? "" : " is-disabled")
                        }
                      >
                        {user.status === "ACTIVE" ? "启用" : "停用"}
                      </span>
                      {(user.openTaskCount ?? 0) > 0 ? (
                        <span className="member-task-count">
                          {user.openTaskCount + " 个未完成任务"}
                        </span>
                      ) : null}
                    </div>
                    <div className="member-actions">
                      {selfAdmin(user) && user.status === "ACTIVE" ? (
                        <Button
                          className="text-button member-action-placeholder"
                          htmlType="button"
                          tabIndex={-1}
                          disabled
                          aria-hidden="true"
                        >
                          停用
                        </Button>
                      ) : null}
                      {!selfAdmin(user) && user.status === "ACTIVE" ? (
                        <Button
                          className="text-button"
                          htmlType="button"
                          onClick={() => openDisable(user)}
                        >
                          停用
                        </Button>
                      ) : null}
                      {!selfAdmin(user) && user.status === "DISABLED" ? (
                        <Button
                          className="text-button"
                          htmlType="button"
                          onClick={() => openLifecycle("enable", user)}
                        >
                          启用
                        </Button>
                      ) : null}
                      <Button
                        className="text-button"
                        htmlType="button"
                        onClick={() => openUpdate(user)}
                      >
                        编辑
                      </Button>
                      {!selfAdmin(user) && user.status === "DISABLED" ? (
                        <Button
                          className="text-button danger-text"
                          htmlType="button"
                          onClick={() => openLifecycle("delete", user)}
                        >
                          强制删除
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {orgMode !== "browse" ? (
              <div
                className="member-batchbar"
                role="region"
                aria-label="批量操作"
              >
                <span>{"已选 " + selectedUserIds.length + " 人"}</span>
                {orgMode === "join" ? (
                  <>
                    <CalmSelect
                      ariaLabel="目标组织"
                      appearance="menu"
                      className="member-org-select"
                      options={joinOrganizationOptions}
                      placeholder="选择组织…"
                      value={joinTarget}
                      width={220}
                      onChange={(value) => setJoinTarget(String(value))}
                    />
                    {joinTarget === "new" ? (
                      <Input
                        aria-label="新组织名称"
                        placeholder="填写组织名称"
                        value={newOrganizationName}
                        onChange={(event) =>
                          setNewOrganizationName(event.target.value)
                        }
                      />
                    ) : null}
                    <span className="member-batchbar-actions">
                      <Button
                        type="primary"
                        loading={organizationMutation.isPending}
                        onClick={() => void joinSelected()}
                      >
                        加入组织
                      </Button>
                      <Button onClick={resetOrgMode}>取消</Button>
                    </span>
                  </>
                ) : (
                  <>
                    <span>{"「" + organizationName(orgTarget) + "」"}</span>
                    <span className="member-batchbar-actions">
                      <Button
                        loading={organizationMutation.isPending}
                        onClick={() => void leaveSelected()}
                      >
                        移出到未分配
                      </Button>
                      <Button onClick={resetOrgMode}>取消</Button>
                    </span>
                  </>
                )}
              </div>
            ) : null}
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
          <div className="admin-user-status">
            <label>账号状态</label>
            <div className="admin-user-status-line">
              <CalmBadge tone={editor?.status === "ACTIVE" ? "green" : "gray"}>
                {editor?.status === "ACTIVE" ? "启用" : "停用"}
              </CalmBadge>
            </div>
            {editor !== null && !selfAdmin(editor) ? (
              <Space wrap>
                {editor.status === "ACTIVE" ? (
                  <Button
                    htmlType="button"
                    danger
                    onClick={() => openDisable(editor)}
                  >
                    停用账号
                  </Button>
                ) : (
                  <>
                    <Button
                      htmlType="button"
                      onClick={() => openLifecycle("enable", editor)}
                    >
                      启用账号
                    </Button>
                    <Button
                      htmlType="button"
                      danger
                      onClick={() => openLifecycle("delete", editor)}
                    >
                      强制删除
                    </Button>
                  </>
                )}
              </Space>
            ) : editor !== null ? (
              <p>当前登录账号不能停用自己。</p>
            ) : null}
          </div>
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

      <DisableAccountModal
        open={disableTarget !== null}
        client={client}
        user={disableTarget}
        pending={mutation.isPending}
        error={mutation.isError ? mutation.error : null}
        onClose={closeDisable}
        onConfirm={confirmDisable}
      />

      <Modal
        className="catalog-modal"
        open={lifecycle !== null}
        eyebrow={
          lifecycle ? "账号 · " + lifecycle.user.loginName : "账号生命周期"
        }
        title={lifecycle ? lifecycleCopy[lifecycle.action].title : ""}
        // 停用与删除是破坏性动作（红）、启用是挽回（绿）。
        tone={
          lifecycle !== null && lifecycle.action === "enable"
            ? "success"
            : "danger"
        }
        icon={
          lifecycle === null || lifecycle.action !== "enable"
            ? "alert"
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
                danger={lifecycle.action !== "enable"}
                loading={mutation.isPending}
                onClick={() => void confirmLifecycle()}
              >
                {lifecycle.action === "delete" ? "确认删除" : "确认"}
              </Button>
            </Space>
          </>
        )}
      </Modal>
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
