import React, { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Form, Input, Typography } from "antd";
import { Controller, useForm } from "react-hook-form";
import type { CreateProjectResponse, InpulseApiClient } from "@generated/api";
import { AppModal as Modal } from "@features/common/components/AppModal";
import {
  organizationDisplayName,
  organizationDisplayPath,
} from "@shared/organizations/organization-display";
import {
  CalmSelect,
  type CalmSelectOption,
} from "@features/common/components/CalmSelect";
import {
  useUserDirectoryQuery,
  describeUserDirectoryError,
} from "@features/users/user-directory-query";
import {
  deriveProjectCardShortname,
  deriveProjectCodeFromName,
  normalizeProjectCode,
  projectFormSchema,
  PROJECT_CODE_MAX_LENGTH,
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  toCreateProjectRequest,
  type ProjectFormValues,
} from "./project-form";
import { describeCreateProjectError, useCreateProject } from "./project-query";

const { Text } = Typography;

export interface CreateProjectModalProps {
  readonly open: boolean;
  readonly creatorName: string;
  readonly creatorUserId?: number | undefined;
  readonly client?: InpulseApiClient | undefined;
  readonly onClose: () => void;
  readonly onCreated: (response: CreateProjectResponse) => void;
}

const defaultValues: ProjectFormValues = {
  name: "",
  code: "",
  description: "",
};

export const CreateProjectModal: React.FC<CreateProjectModalProps> = ({
  open,
  creatorName,
  creatorUserId,
  client,
  onClose,
  onCreated,
}) => {
  const {
    control,
    handleSubmit,
    reset,
    watch,
    setError,
    setValue,
    clearErrors,
    formState: { errors },
  } = useForm<ProjectFormValues>({
    defaultValues,
    mode: "onSubmit",
  });
  const mutation = useCreateProject({ client });
  const formId = React.useId();
  const directory = useUserDirectoryQuery({ client, enabled: open });
  const [selectedGroupKeys, setSelectedGroupKeys] = useState<string[]>([]);
  const [manualMemberIds, setManualMemberIds] = useState<number[]>([]);
  // 用户手动填过编码就不再被名称推导覆盖；清空编码视为交回自动推导。
  const codeManuallyEditedRef = useRef(false);
  const code = watch("code") ?? "";
  const cardShortname = deriveProjectCardShortname(code);
  const candidates = useMemo(
    () => (directory.data ?? []).filter((user) => user.id !== creatorUserId),
    [creatorUserId, directory.data],
  );

  /** ADR-097：候选成员按全部所属组织聚组；多群组账号会出现在每个小组。 */
  const organizationGroups = useMemo(() => {
    const order: string[] = [];
    const buckets = new Map<string, number[]>();
    const labels = new Map<string, string>();
    const fullPaths = new Map<string, string>();
    for (const user of candidates) {
      for (const organization of user.organizations) {
        const key = String(organization.id);
        if (!buckets.has(key)) {
          buckets.set(key, []);
          order.push(key);
          labels.set(key, organizationDisplayName(organization));
          fullPaths.set(key, organizationDisplayPath(organization));
        }
        buckets.get(key)?.push(user.id);
      }
    }
    return order.map((key) => ({
      key,
      name: labels.get(key) ?? key,
      fullPath: fullPaths.get(key) ?? labels.get(key) ?? key,
      memberIds: buckets.get(key) ?? [],
    }));
  }, [candidates]);

  const selectedMemberIds = useMemo(() => {
    const selected = new Set(manualMemberIds);
    for (const group of organizationGroups) {
      if (!selectedGroupKeys.includes(group.key)) continue;
      for (const memberId of group.memberIds) selected.add(memberId);
    }
    return candidates
      .filter((user) => selected.has(user.id))
      .map((user) => user.id);
  }, [candidates, manualMemberIds, organizationGroups, selectedGroupKeys]);

  const userGroupLabel = (
    organizations: readonly {
      readonly name: string;
      readonly source: "LOCAL" | "CASDOOR";
      readonly groupPath: string | null;
    }[],
  ) =>
    organizations.length === 0
      ? "未分类"
      : organizations
          .map((organization) => organizationDisplayName(organization))
          .join("、");

  // 整组选择只列真实组织：未分类不是真实组织，逐人挑选仍走下方搜索框。
  const assignedOrganizationGroups = organizationGroups;
  const hasOrganizationGroups = assignedOrganizationGroups.length > 0;

  /** 创建者固定出现在「选择成员」里：值排第一位，选项标 disabled 后 rc-select 不渲染移除按钮。 */
  const creatorEntry = (directory.data ?? []).find(
    (user) => user.id === creatorUserId,
  );
  const creatorOption: CalmSelectOption | null =
    creatorUserId === undefined
      ? null
      : {
          value: creatorUserId,
          label: creatorName,
          avatarUrl: creatorEntry?.avatarUrl ?? null,
          group: userGroupLabel(creatorEntry?.organizations ?? []),
          description: "创建者",
          disabled: true,
        };
  const memberOptions: CalmSelectOption[] = [
    ...(creatorOption === null ? [] : [creatorOption]),
    ...candidates.map((user) => ({
      value: user.id,
      label: user.name,
      avatarUrl: user.avatarUrl ?? null,
      group: userGroupLabel(user.organizations),
      description:
        userGroupLabel(user.organizations) +
        (user.isAdmin ? " · 系统管理员" : ""),
    })),
  ];
  const memberSelectValues =
    creatorUserId === undefined
      ? selectedMemberIds
      : [creatorUserId, ...selectedMemberIds];
  const memberCount =
    selectedMemberIds.length + (creatorUserId === undefined ? 0 : 1);

  useEffect(() => {
    if (open) {
      reset(defaultValues);
      setManualMemberIds([]);
      setSelectedGroupKeys([]);
      codeManuallyEditedRef.current = false;
      mutation.reset();
    }
  }, [open]);

  const handleSubmitForm = async (values: ProjectFormValues) => {
    const parsed = projectFormSchema.safeParse(values);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === "name" || field === "code" || field === "description") {
          setError(field, { message: issue.message });
        }
      }
      return;
    }
    try {
      const response = await mutation.mutateAsync(
        toCreateProjectRequest(parsed.data, selectedMemberIds),
      );
      mutation.reset();
      onCreated(response);
      onClose();
    } catch {
      // 错误由 mutation.error 展示，服务器内部消息不下发到界面。
    }
  };

  const toggleOrganization = (groupKey: string) => {
    setSelectedGroupKeys((current) =>
      current.includes(groupKey)
        ? current.filter((key) => key !== groupKey)
        : [...current, groupKey],
    );
  };

  const handleCancel = () => {
    if (!mutation.isPending) {
      onClose();
    }
  };

  return (
    <Modal
      className="catalog-modal"
      size="lg"
      title="新建项目"
      destroyOnHidden
      mask={{ closable: false }}
      open={open}
      onCancel={handleCancel}
      footer={
        <>
          <Button disabled={mutation.isPending} onClick={handleCancel}>
            取消
          </Button>
          <Button
            type="primary"
            htmlType="submit"
            form={formId}
            loading={mutation.isPending}
          >
            创建项目
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="catalog-form catalog-form-create calm-form"
        onSubmit={handleSubmit((values) => void handleSubmitForm(values))}
        noValidate
      >
        <Form component={false} layout="vertical" requiredMark={false}>
          <div className="dialog-form">
            <Controller
              name="name"
              control={control}
              render={({ field }) => (
                <Form.Item
                  label="项目名称"
                  required
                  validateStatus={errors.name ? "error" : ""}
                  help={errors.name?.message ?? ""}
                >
                  <Input
                    {...field}
                    id="project-name"
                    aria-label="项目名称"
                    maxLength={PROJECT_NAME_MAX_LENGTH}
                    placeholder="例如：商城系统"
                    disabled={mutation.isPending}
                    onChange={(event) => {
                      const nextName = event.currentTarget.value;
                      field.onChange(nextName);
                      clearErrors("name");
                      if (!codeManuallyEditedRef.current) {
                        setValue("code", deriveProjectCodeFromName(nextName));
                        clearErrors("code");
                      }
                    }}
                  />
                </Form.Item>
              )}
            />
            <div className="form-row">
              <Controller
                name="code"
                control={control}
                render={({ field }) => (
                  <Form.Item
                    label="项目编码"
                    required
                    style={{ flex: 1 }}
                    validateStatus={errors.code ? "error" : ""}
                    help={errors.code?.message ?? ""}
                  >
                    <Input
                      {...field}
                      id="project-code"
                      aria-label="项目编码"
                      maxLength={PROJECT_CODE_MAX_LENGTH}
                      placeholder="SHOP"
                      disabled={mutation.isPending}
                      onChange={(event) => {
                        const nextCode = normalizeProjectCode(
                          event.currentTarget.value,
                        );
                        field.onChange(nextCode);
                        clearErrors("code");
                        codeManuallyEditedRef.current = nextCode.length > 0;
                      }}
                    />
                  </Form.Item>
                )}
              />
              <Form.Item label="卡片简称" style={{ flex: 1 }}>
                <Input
                  id="project-card-shortname"
                  aria-label="卡片简称"
                  value={cardShortname}
                  disabled
                />
              </Form.Item>
            </div>
            <fieldset className="impact-fieldset">
              <legend>项目成员</legend>
              {!directory.isPending && !directory.isError ? (
                <>
                  {hasOrganizationGroups ? (
                    <div
                      className="member-org-picks"
                      role="group"
                      aria-label="按组织选择"
                    >
                      {assignedOrganizationGroups.map((group) => {
                        const selectedCount = group.memberIds.filter((id) =>
                          selectedMemberIds.includes(id),
                        ).length;
                        const allSelected =
                          group.memberIds.length > 0 &&
                          selectedCount === group.memberIds.length;
                        const active = selectedGroupKeys.includes(group.key);
                        const action = active
                          ? "取消全选组织 "
                          : allSelected
                            ? "组织已全选 "
                            : "全选组织 ";
                        return (
                          <button
                            key={group.key}
                            type="button"
                            className={
                              "member-org-pick" +
                              (allSelected
                                ? " is-selected"
                                : selectedCount > 0
                                  ? " is-partial"
                                  : "")
                            }
                            aria-pressed={active}
                            aria-label={
                              action +
                              group.name +
                              "（已选 " +
                              selectedCount +
                              "/" +
                              group.memberIds.length +
                              " 人）"
                            }
                            title={group.fullPath}
                            disabled={mutation.isPending}
                            onClick={() => toggleOrganization(group.key)}
                          >
                            <span className="member-org-pick-name">
                              {group.name}
                            </span>
                            <span className="member-org-pick-count">
                              {selectedCount}/{group.memberIds.length}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                  <div className="calm-field">
                    <label htmlFor="project-member-candidates">
                      选择成员
                      <span className="member-count">共 {memberCount} 人</span>
                    </label>
                    <CalmSelect
                      id="project-member-candidates"
                      ariaLabel="选择项目成员"
                      appearance="member"
                      multiple
                      maxTagCount="responsive"
                      value={memberSelectValues}
                      onChange={(next) => {
                        setManualMemberIds(
                          next.map(Number).filter((id) => id !== creatorUserId),
                        );
                        // 直接编辑成员即把整组选择降级为手工快照，避免隐藏的组织开关
                        // 在之后覆盖用户刚刚取消的成员。
                        setSelectedGroupKeys([]);
                      }}
                      placeholder="输入姓名或组织搜索，可一次选择多位启用用户"
                      disabled={mutation.isPending}
                      options={memberOptions}
                      animated
                      forcePopupBelow
                    />
                  </div>
                  {candidates.length === 0 ? (
                    <Text type="secondary" className="member-hint">
                      暂无其他启用用户，创建者已自动加入。
                    </Text>
                  ) : null}
                </>
              ) : directory.isPending ? (
                /* 占位沿用真字段的 .calm-field + label 结构，控件占位与 CalmSelect 同为 32px；
                   原先的 compact 骨架是 100px，数据到达后掉到 54px，弹层会先大后小地闪一下。 */
                <div className="calm-field">
                  <label htmlFor="project-member-candidates">选择成员</label>
                  <span
                    className="calm-sk calm-sk-control"
                    aria-hidden="true"
                  />
                  <span className="sr-only" role="status">
                    正在加载成员...
                  </span>
                </div>
              ) : (
                <Alert
                  showIcon
                  type="error"
                  message={describeUserDirectoryError(directory.error)}
                />
              )}
            </fieldset>
            <Controller
              name="description"
              control={control}
              render={({ field }) => (
                <Form.Item
                  label="项目描述"
                  validateStatus={errors.description ? "error" : ""}
                  help={errors.description?.message ?? ""}
                >
                  <Input.TextArea
                    {...field}
                    id="project-description"
                    aria-label="项目描述"
                    rows={3}
                    maxLength={PROJECT_DESCRIPTION_MAX_LENGTH}
                    placeholder="描述项目目标、交付范围与现场背景"
                    disabled={mutation.isPending}
                    onChange={(event) => {
                      field.onChange(event.currentTarget.value);
                      clearErrors("description");
                    }}
                  />
                </Form.Item>
              )}
            />
          </div>
          <aside className="writing-context">
            <strong>创建规则</strong>
            <dl>
              <dt>创建者</dt>
              <dd>自动成为活跃成员，创建流程中不可取消</dd>
              <dt>编码</dt>
              <dd>创建后不可修改，仅用于溯源</dd>
              <dt>模块</dt>
              <dd>按需手动创建，项目也可以没有模块</dd>
              <dt>系统管理员</dt>
              <dd>自动拥有项目访问权，即使不在成员列表</dd>
            </dl>
            <p className="permission-hint">
              项目创建与成员初始化在同一事务中完成，成员创建成功后收到加入通知。
            </p>
          </aside>
          {mutation.error ? (
            <Alert
              showIcon
              type="error"
              title={describeCreateProjectError(mutation.error)}
              style={{ marginBottom: 16 }}
            />
          ) : null}
        </Form>
      </form>
    </Modal>
  );
};
