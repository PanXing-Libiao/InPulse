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
  skip: "跳过",
};

const reasonLabel: Readonly<Record<CasdoorImportSkipReason, string>> = {
  "account-disabled": "平台账号已停用",
  "account-deleted": "平台账号已删除",
  "subject-bound-to-other-account": "Casdoor 身份已绑定其他平台账号",
  "email-mismatch": "登录名相同但邮箱不一致",
  "email-taken": "邮箱已被其他平台账号使用",
};

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

  const items = preview.data?.items ?? [];
  const selectableItems = useMemo(
    () => items.filter((item) => item.action !== "skip"),
    [items],
  );
  const allSelected =
    selectableItems.length > 0 &&
    selectableItems.every((item) => selectedIds.includes(item.casdoorId));
  const someSelected = selectedIds.length > 0 && !allSelected;

  useEffect(() => {
    if (!open) return;
    const next = (preview.data?.items ?? [])
      .filter((item) => item.action !== "skip")
      .map((item) => item.casdoorId);
    setSelectedIds(next);
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
    if (item.action === "skip") return;
    setSelectedIds((current) =>
      checked
        ? current.includes(item.casdoorId)
          ? current
          : [...current, item.casdoorId]
        : current.filter((id) => id !== item.casdoorId),
    );
  };

  const toggleAll = (checked: boolean) => {
    setSelectedIds(
      checked ? selectableItems.map((item) => item.casdoorId) : [],
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
            "只读取配置组织下启用中的账号；正式环境会按 InPulse 应用权限收窄候选范围，并仅保留权限内的 Casdoor Physical 实体组。没有实体组的账号会进入未分类；Virtual 组、停用账号和已删除账号不会导入。"
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
            <div className="casdoor-import-summary" aria-label="导入分类统计">
              <span>组织：{preview.data.organization}</span>
              <span>扫描：{preview.data.scannedUserCount}</span>
              <span>新建：{preview.data.counts.create}</span>
              <span>绑定：{preview.data.counts.link}</span>
              <span>刷新：{preview.data.counts.refresh}</span>
              <span>跳过：{preview.data.counts.skip}</span>
            </div>

            <div className="casdoor-import-selectbar">
              <Checkbox
                checked={allSelected}
                indeterminate={someSelected}
                disabled={selectableItems.length === 0 || mutation.isPending}
                onChange={(event) => toggleAll(event.target.checked)}
              >
                全选可导入账号
              </Checkbox>
              <span>已选 {selectedIds.length} 个</span>
              <Button size="small" onClick={() => void preview.refetch()}>
                刷新预览
              </Button>
            </div>

            {items.length === 0 ? (
              <div className="casdoor-import-state">
                当前组织没有可导入的启用账号。
              </div>
            ) : (
              <div className="casdoor-import-list" role="list">
                {items.map((item) => (
                  <div
                    className={
                      "casdoor-import-row" +
                      (item.action === "skip" ? " is-skipped" : "")
                    }
                    role="listitem"
                    key={item.casdoorId}
                  >
                    <Checkbox
                      aria-label={"选择 " + item.displayName}
                      checked={selectedIds.includes(item.casdoorId)}
                      disabled={item.action === "skip" || mutation.isPending}
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
                      <Tag color={item.action === "skip" ? "default" : "blue"}>
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
