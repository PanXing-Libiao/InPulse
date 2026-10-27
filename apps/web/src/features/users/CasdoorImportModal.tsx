import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Checkbox, Tag } from "antd";
import type {
  CasdoorImportAction,
  CasdoorImportPreviewItem,
  CasdoorImportResult,
  CasdoorImportSkipReason,
  InpulseApiClient,
} from "@generated/api";

import { AppModal as Modal } from "@features/common/components/AppModal";
import { organizationDisplayName } from "@shared/organizations/organization-display";
import {
  casdoorImportErrorMessage,
  useCasdoorImport,
  useCasdoorImportPreview,
} from "./admin-user-query";

const actionLabel: Readonly<Record<CasdoorImportAction, string>> = {
  create: "新账号",
  link: "绑定现有账号",
  refresh: "刷新资料与组织",
  unchanged: "无变化",
  skip: "跳过",
};

const actionColor: Readonly<Record<CasdoorImportAction, string>> = {
  create: "green",
  link: "cyan",
  refresh: "blue",
  unchanged: "default",
  skip: "default",
};

const reasonLabel: Readonly<Record<CasdoorImportSkipReason, string>> = {
  "account-disabled": "平台账号已停用",
  "account-deleted": "平台账号已删除",
  "subject-bound-to-other-account": "Casdoor 身份已绑定其他平台账号",
  "email-mismatch": "登录名相同但邮箱不一致",
  "email-taken": "邮箱已被其他平台账号使用",
};

type ImportFilter = "all" | CasdoorImportAction;

function isImportableAction(
  action: CasdoorImportAction,
): action is "create" | "link" | "refresh" {
  return action === "create" || action === "link" || action === "refresh";
}

export interface CasdoorImportModalProps {
  readonly open: boolean;
  readonly client?: InpulseApiClient | undefined;
  readonly onClose: () => void;
  readonly onImported: (result: CasdoorImportResult) => void;
}

export function CasdoorImportModal({
  open,
  client,
  onClose,
  onImported,
}: CasdoorImportModalProps) {
  const preview = useCasdoorImportPreview(client, { enabled: open });
  const mutation = useCasdoorImport(client, onImported);
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [actionFilter, setActionFilter] = useState<ImportFilter>("all");

  const items = preview.data?.items ?? [];
  const filteredItems = useMemo(
    () =>
      actionFilter === "all"
        ? items
        : items.filter((item) => item.action === actionFilter),
    [actionFilter, items],
  );
  const selectableItems = useMemo(
    () => filteredItems.filter((item) => isImportableAction(item.action)),
    [filteredItems],
  );
  const allSelected =
    selectableItems.length > 0 &&
    selectableItems.every((item) => selectedIds.includes(item.casdoorId));
  const someSelected =
    selectableItems.some((item) => selectedIds.includes(item.casdoorId)) &&
    !allSelected;
  const filterOptions: readonly {
    readonly key: ImportFilter;
    readonly label: string;
    readonly count: number;
  }[] = preview.data
    ? [
        { key: "all", label: "全部", count: items.length },
        { key: "create", label: "新建", count: preview.data.counts.create },
        { key: "link", label: "绑定", count: preview.data.counts.link },
        { key: "refresh", label: "刷新", count: preview.data.counts.refresh },
        {
          key: "unchanged",
          label: "无变化",
          count: preview.data.counts.unchanged,
        },
        { key: "skip", label: "跳过", count: preview.data.counts.skip },
      ]
    : [];

  useEffect(() => {
    if (!open) return;
    const next = (preview.data?.items ?? [])
      .filter((item) => isImportableAction(item.action))
      .map((item) => item.casdoorId);
    setSelectedIds(next);
    setActionFilter("all");
  }, [open, preview.data?.fetchedAt]);

  useEffect(() => {
    if (open) mutation.reset();
  }, [open, mutation.reset]);

  const close = () => {
    if (mutation.isPending) return;
    mutation.reset();
    onClose();
  };

  const toggleUser = (item: CasdoorImportPreviewItem, checked: boolean) => {
    if (!isImportableAction(item.action)) return;
    setSelectedIds((current) =>
      checked
        ? current.includes(item.casdoorId)
          ? current
          : [...current, item.casdoorId]
        : current.filter((id) => id !== item.casdoorId),
    );
  };

  const toggleAll = (checked: boolean) => {
    const visibleIds = new Set(selectableItems.map((item) => item.casdoorId));
    setSelectedIds((current) =>
      checked
        ? [...new Set([...current, ...visibleIds])]
        : current.filter((id) => !visibleIds.has(id)),
    );
  };

  const confirm = async () => {
    if (selectedIds.length === 0 || mutation.isPending) return;
    try {
      await mutation.mutateAsync(selectedIds);
    } catch {
      // 错误由 mutation.error 统一展示。
    }
  };

  return (
    <Modal
      open={open}
      className="casdoor-import-modal"
      size="xl"
      eyebrow="Casdoor 目录"
      title="从 Casdoor 导入账号"
      body
      mask={{ closable: !mutation.isPending }}
      onCancel={close}
      footer={
        <>
          <Button onClick={close} disabled={mutation.isPending}>
            取消
          </Button>
          <Button
            type="primary"
            loading={mutation.isPending}
            disabled={selectedIds.length === 0 || preview.isError}
            onClick={() => void confirm()}
          >
            {"导入 " + selectedIds.length + " 个账号"}
          </Button>
        </>
      }
    >
      <div className="casdoor-import">
        <p className="casdoor-import-intro">
          {
            "只读取配置组织下启用中的账号；正式环境会按 InPulse 应用权限收窄候选范围，并仅保留权限内的 Casdoor Physical 实体组。没有实体组的账号会进入未分类；Virtual 组、停用账号和已删除账号不会导入。已导入账号仅在姓名、邮箱或实体组发生变化时标记刷新，无变化账号不会默认勾选。"
          }
        </p>

        {preview.isPending ? (
          <div className="casdoor-import-state" role="status">
            正在读取 Casdoor 用户与实体组…
          </div>
        ) : null}

        {preview.isError ? (
          <div className="casdoor-import-state">
            <Alert
              type="error"
              title={casdoorImportErrorMessage(preview.error)}
            />
            <Button onClick={() => void preview.refetch()}>重新读取</Button>
          </div>
        ) : null}

        {preview.data ? (
          <>
            <div className="casdoor-import-summary" aria-label="导入目录信息">
              <span>组织：{preview.data.organization}</span>
              <span>扫描：{preview.data.scannedUserCount}</span>
            </div>

            <div
              className="casdoor-import-filters"
              role="group"
              aria-label="按导入分类筛选"
            >
              {filterOptions.map((option) => (
                <button
                  type="button"
                  className="casdoor-import-filter"
                  aria-pressed={actionFilter === option.key}
                  key={option.key}
                  onClick={() => setActionFilter(option.key)}
                >
                  <span>{option.label}</span>
                  <strong>{option.count}</strong>
                </button>
              ))}
            </div>

            <div className="casdoor-import-selectbar">
              <Checkbox
                checked={allSelected}
                indeterminate={someSelected}
                disabled={selectableItems.length === 0 || mutation.isPending}
                onChange={(event) => toggleAll(event.target.checked)}
              >
                {actionFilter === "all" ? "全选可导入账号" : "全选当前筛选"}
              </Checkbox>
              <span>已选 {selectedIds.length} 个</span>
              {actionFilter === "all" ? null : (
                <span>当前 {filteredItems.length} 条</span>
              )}
              <Button size="small" onClick={() => void preview.refetch()}>
                刷新预览
              </Button>
            </div>

            {filteredItems.length === 0 ? (
              <div className="casdoor-import-state">
                {items.length === 0
                  ? "当前组织没有可导入的启用账号。"
                  : "当前筛选没有账号。"}
              </div>
            ) : (
              <div className="casdoor-import-list" role="list">
                {filteredItems.map((item) => (
                  <div
                    className={
                      "casdoor-import-row" +
                      (item.action === "skip"
                        ? " is-skipped"
                        : item.action === "unchanged"
                          ? " is-unchanged"
                          : "")
                    }
                    role="listitem"
                    key={item.casdoorId}
                  >
                    <Checkbox
                      aria-label={"选择 " + item.displayName}
                      checked={selectedIds.includes(item.casdoorId)}
                      disabled={
                        !isImportableAction(item.action) || mutation.isPending
                      }
                      onChange={(event) =>
                        toggleUser(item, event.target.checked)
                      }
                    />
                    <div className="casdoor-import-identity">
                      <strong>{item.displayName}</strong>
                      <span>{item.loginName}</span>
                      <span>{item.email ?? "未填写邮箱"}</span>
                    </div>
                    <div className="casdoor-import-groups">
                      {item.groups.length === 0 ? (
                        <span className="casdoor-import-unclassified">
                          未分类（无实体组）
                        </span>
                      ) : (
                        item.groups.map((group) => {
                          const name = group.split("/").at(-1) ?? group;
                          return (
                            <Tag key={group} title={group}>
                              {organizationDisplayName({
                                name,
                                source: "CASDOOR",
                              })}
                            </Tag>
                          );
                        })
                      )}
                    </div>
                    <div className="casdoor-import-action">
                      <Tag color={actionColor[item.action]}>
                        {actionLabel[item.action]}
                      </Tag>
                      {item.reason ? (
                        <span>{reasonLabel[item.reason]}</span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : null}

        {mutation.isError ? (
          <Alert
            type="error"
            title={casdoorImportErrorMessage(mutation.error)}
          />
        ) : null}
      </div>
    </Modal>
  );
}
