import "./external-links.css";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Checkbox, Input, Tag } from "antd";
import { AppModal as Modal } from "@features/common/components/AppModal";
import { InpulseIcon } from "@features/common/components/InpulseIcon";
import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  createApiClient,
  type InpulseApiClient,
  type ExternalLinkItem,
  type ExternalLinkList,
  type ExternalLinkTargetPath,
} from "@generated/api";
import { createIdempotencyKey } from "@shared/api/idempotency-key";
import { CalmSkeleton } from "@features/common/components/CalmSkeleton";
import { repositoryDisplayPath } from "./repository-path";
import { SESSION_EXPIRED_MESSAGE } from "@shared/api/request-messages";
type TargetType = ExternalLinkTargetPath["targetType"];
type ExternalLinkSource = NonNullable<ExternalLinkItem["sources"]>[number];
/** 来源标注文案：项目面板聚合任务 / 功能 / 记录上的链接时展示（2026-10-09）。 */
export function externalLinkSourceLabel(source: ExternalLinkSource): string {
  switch (source.targetType) {
    case "PROJECT":
      return "本项目";
    case "TASK":
      return "任务「" + source.title + "」";
    case "FEATURE":
      return "功能「" + source.title + "」";
    case "CHANGE_RECORD":
      return "记录「" + source.title + "」";
  }
}
/** 全部来源合并为一行的标注文本；其他目标不返回来源时返回 null。 */
export function externalLinkSourceText(item: ExternalLinkItem): string | null {
  if (item.sources === undefined || item.sources.length === 0) return null;
  return item.sources.map(externalLinkSourceLabel).join("、");
}
/**
 * 聚合条目可能只来自任务 / 功能 / 记录：解除只在链接仍有项目级关联时提供，
 * 来源处各自保留自己的解除入口（写入模型不变）。
 */
export function canRemoveExternalLink(
  targetType: TargetType,
  item: ExternalLinkItem,
): boolean {
  if (targetType !== "PROJECT") return true;
  return (
    item.sources?.some((source) => source.targetType === "PROJECT") ?? true
  );
}
/** 设计师稿 github-links 的徽章文案：先看 Release 标记，再看链接类型。 */
export function externalLinkKindLabel(item: ExternalLinkItem): string {
  return item.releaseTag
    ? "Release"
    : item.kind === "PULL_REQUEST"
      ? "PR"
      : item.kind === "ISSUE"
        ? "Issue"
        : item.kind === "COMMIT"
          ? "Commit"
          : "链接";
}
export function ExternalLinksPanel({
  targetType,
  targetId,
  client,
  variant = "button",
  triggerClassName,
  triggerUnconfiguredHint,
}: {
  targetType: TargetType;
  targetId: number;
  client?: InpulseApiClient | undefined;
  /** `inline` 按设计师稿在页面内直接展示列表与新增表单；`button` 保持弹层形态。 */
  variant?: "button" | "inline";
  /** `button` 形态下触发按钮的样式类，用于融入所在页面的动作区。 */
  triggerClassName?: string | undefined;
  /** 传入后把触发按钮标记为「待配置」：虚线描边，并把该文案作为悬停提示。 */
  triggerUnconfiguredHint?: string | undefined;
}) {
  const api = useMemo(() => client ?? createApiClient(), [client]),
    cache = useQueryClient();
  const [open, setOpen] = useState(false),
    [data, setData] = useState<ExternalLinkList | null>(null),
    [busy, setBusy] = useState(false),
    [opening, setOpening] = useState(false),
    [url, setUrl] = useState(""),
    [error, setError] = useState<unknown>(null),
    [needsRefresh, setNeedsRefresh] = useState(false),
    [removeId, setRemoveId] = useState<number | null>(null),
    [adding, setAdding] = useState(false);
  const [isRootRepository, setIsRootRepository] = useState(false);
  const saving = useRef(false),
    retry = useRef<{ signature: string; key: string } | null>(null);
  async function load() {
    setBusy(true);
    try {
      const latest = await api.listExternalLinks(targetType, targetId);
      setData(latest);
      setNeedsRefresh(false);
      setError(null);
      retry.current = null;
    } catch (e) {
      setError(e);
      if (e instanceof ApiError && [401, 403, 404].includes(e.status))
        setData(null);
    } finally {
      setBusy(false);
    }
  }
  /**
   * 打开弹层前先把关联列表取回来（2026-09-30「弹窗首帧不跳尺寸」）：弹层里原本只有一条
   * 82px 骨架，真内容是根仓库卡片 + 链接列表（实测 284px → 747px），先开后填会让盒子在
   * 数据到达时长高一大截。改为在触发按钮上转圈、数据就绪再开；加载失败也要打开，
   * 让错误与「加载最新关联」留在弹层里。
   */
  async function openPanel() {
    if (data !== null || needsRefresh) {
      setOpen(true);
      return;
    }
    setOpening(true);
    try {
      await load();
    } finally {
      setOpening(false);
      setOpen(true);
    }
  }
  async function save() {
    if (
      saving.current ||
      busy ||
      needsRefresh ||
      !data?.writable ||
      (!removeId && !url.trim())
    )
      return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      const signature = JSON.stringify([
        targetType,
        targetId,
        data.rowVersion,
        removeId,
        url.trim(),
        isRootRepository,
      ]);
      if (retry.current?.signature !== signature)
        retry.current = {
          signature,
          key: createIdempotencyKey("external-link"),
        };
      const csrf = await api.issueCsrfToken(),
        init = {
          headers: {
            "x-csrf-token": csrf.csrfToken,
            "If-Match": `"${data.rowVersion}"`,
            "Idempotency-Key": retry.current.key,
          },
        };
      if (removeId)
        await api.removeExternalLink(targetType, targetId, removeId, init);
      else
        await api.addExternalLink(
          targetType,
          targetId,
          {
            url: url.trim(),
            ...(targetType === "PROJECT" ? { isRootRepository } : {}),
          },
          init,
        );
      retry.current = null;
      setUrl("");
      setIsRootRepository(false);
      setRemoveId(null);
      setAdding(false);
      // The mutation has succeeded. Prevent stale resubmission even if the subsequent reload fails.
      setNeedsRefresh(true);
      for (const key of [
        "projects",
        "project-repository",
        "features",
        "tasks",
        "record-drafts",
        "record-draft",
        "record-feed",
        "published-record",
        "task-record-drafts",
        "search",
        "activity",
        "activity-center",
      ])
        void cache.invalidateQueries({ queryKey: [key] });
      await load();
    } catch (e) {
      setError(e);
      if (e instanceof ApiError && e.status === 409) setNeedsRefresh(true);
      if (e instanceof ApiError && [401, 403, 404].includes(e.status))
        setData(null);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  const message =
    error instanceof ApiError
      ? error.status === 401
        ? SESSION_EXPIRED_MESSAGE
        : error.status === 403
          ? "当前操作未获授权，请刷新后重试。"
          : error.status === 404
            ? "目标不存在或当前无法访问。"
            : error.status === 409
              ? error.code === "EXTERNAL_LINK_ALREADY_ASSOCIATED"
                ? isRootRepository
                  ? "该链接及根仓库设置已存在。"
                  : "该链接已关联，请勿重复添加。"
                : "目标状态或版本已变化，请加载最新关联后重新确认。"
              : error.status === 422
                ? error.code === "SEARCH_TEXT_CAPACITY_EXCEEDED"
                  ? "正文与链接总量超过搜索容量，请精简正文或解除不需要的链接。"
                  : error.code === "EXTERNAL_LINK_SHA_REQUIRES_ROOT_REPOSITORY"
                    ? "尚未设置项目根仓库，无法把 commit SHA 补全为链接；请先粘贴完整链接或设置项目根仓库。"
                    : "链接无效：只接受 github.com 的 HTTPS 链接，请检查输入。"
                : error.status === 429
                  ? "操作频繁，请稍后重试。"
                  : "暂时无法操作，输入已保留，可重试。"
      : "暂时无法操作，输入已保留，可重试。";
  const inline = variant === "inline";
  useEffect(() => {
    if (inline) void load();
    // 目标或形态变化时重新加载，等价于弹层形态的「打开即加载」。
  }, [inline, targetType, targetId]);
  /** 弹层形态把项目根仓库固定在上半区，并从下半区列表里排除，避免同一条链接出现两次。 */
  const rootRepository =
    targetType === "PROJECT"
      ? (data?.items.find((item) => item.isRootRepository) ?? null)
      : null;
  const linkedItems =
    data === null
      ? []
      : rootRepository === null
        ? data.items
        : data.items.filter((item) => item.id !== rootRepository.id);
  const canWrite = data?.writable === true;
  const addBlocked = busy || needsRefresh;
  /** 弹层与内联形态共用的新增表单字段；弹层形态在点「添加链接」后才展开。 */
  const addFormFields = removeId ? null : (
    <>
      <label htmlFor={"external-link-url-" + targetType + "-" + targetId}>
        GitHub URL
      </label>
      <Input
        id={"external-link-url-" + targetType + "-" + targetId}
        value={url}
        maxLength={2048}
        disabled={busy}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://github.com/owner/repository/pull/123 或 commit SHA"
      />
      {targetType === "PROJECT" && (
        <Checkbox
          checked={isRootRepository}
          disabled={busy}
          onChange={(e) => setIsRootRepository(e.target.checked)}
        >
          设为项目根仓库
          {rootRepository
            ? "（当前：" +
              repositoryDisplayPath(rootRepository.normalizedUrl) +
              "）"
            : ""}
        </Checkbox>
      )}
      {url.trim() && (
        <p role="status">
          {previewLabel(url)
            ? "识别为：" +
              previewLabel(url) +
              (commitShaInput(url) === null
                ? ""
                : "（将用项目根仓库补全为链接）")
            : "请输入有效的 GitHub HTTPS URL 或 commit SHA"}
        </p>
      )}
      <div className="external-links-add-actions">
        {inline ? null : (
          <Button
            disabled={busy}
            onClick={() => {
              setUrl("");
              setIsRootRepository(false);
              setAdding(false);
            }}
          >
            取消
          </Button>
        )}
        <Button
          type="primary"
          disabled={busy || needsRefresh || !url.trim()}
          onClick={() => void save()}
        >
          确认添加
        </Button>
      </div>
    </>
  );
  const addForm = removeId ? (
    <div className="calm-action-footer">
      <p>确认解除此链接的当前关联？</p>
      <Button disabled={busy} onClick={() => setRemoveId(null)}>
        取消解除
      </Button>
      <Button
        danger
        disabled={busy || needsRefresh}
        onClick={() => void save()}
      >
        确认解除关联
      </Button>
    </div>
  ) : (
    addFormFields
  );
  /** 内联形态的操作区：解除确认优先于新增表单，与设计师稿的展开式一致。 */
  const inlineActions =
    removeId !== null || adding ? (
      <div className="github-add">{addForm}</div>
    ) : (
      <button
        type="button"
        className="text-button"
        disabled={busy || needsRefresh}
        onClick={() => setAdding(true)}
      >
        <InpulseIcon name="plus" size={14} />
        添加 GitHub 链接
      </button>
    );
  /** 触发按钮的样式类：页面自带类 + 待配置标记。 */
  const triggerButtonClass = [
    triggerClassName,
    triggerUnconfiguredHint === undefined ? undefined : "is-unconfigured",
  ]
    .filter(Boolean)
    .join(" ");
  if (inline)
    return (
      <div className="github-block">
        {!data && busy && (
          <CalmSkeleton variant="lines" rows={2} compact label="正在加载关联" />
        )}
        {error !== null && <Alert type="error" title={message} />}
        {!data && !busy && (
          <Button disabled={busy} onClick={() => void load()}>
            加载最新关联
          </Button>
        )}
        {data &&
          (data.items.length === 0 ? (
            <p className="muted">
              尚未关联 GitHub。系统只保存 HTTPS
              链接，不抓取远程内容，也不会自动改变任务状态。
            </p>
          ) : (
            <ul className="github-list">
              {data.items.map((item) => (
                <li key={item.id}>
                  <Tag>
                    {item.isRootRepository
                      ? "项目根仓库"
                      : externalLinkKindLabel(item)}
                  </Tag>
                  <a
                    href={item.normalizedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {item.label}
                    <InpulseIcon name="externalLink" size={13} />
                  </a>
                  {item.externalNumber ? (
                    <code>{item.externalNumber}</code>
                  ) : null}
                  {data.writable && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={"解除 " + item.label}
                      disabled={busy || needsRefresh}
                      onClick={() => setRemoveId(item.id)}
                    >
                      <InpulseIcon name="x" size={15} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ))}
        {data?.writable && inlineActions}
      </div>
    );
  return (
    <>
      <Button
        {...(triggerButtonClass === ""
          ? {}
          : { className: triggerButtonClass })}
        {...(triggerUnconfiguredHint === undefined
          ? {}
          : { title: triggerUnconfiguredHint })}
        loading={opening}
        onClick={() => void openPanel()}
      >
        GitHub 链接
      </Button>
      <Modal
        className="catalog-modal"
        title="GitHub 链接"
        open={open}
        body
        onCancel={() => {
          if (!busy) setOpen(false);
        }}
        closable={!busy}
        mask={{ closable: !busy }}
        footer={
          <Button disabled={busy} onClick={() => setOpen(false)}>
            关闭关联
          </Button>
        }
      >
        <div className="external-links-body">
          {/* 刷新时保留旧列表：再插一条骨架会让弹层先长后缩，等于把「闪一下」换个地方。 */}
          {busy && data === null && (
            <CalmSkeleton
              variant="lines"
              rows={2}
              compact
              label="正在加载关联"
            />
          )}
          {error !== null && <Alert type="error" title={message} />}
          {(needsRefresh || (!data && !busy)) && (
            <div className="external-links-refresh">
              <Button disabled={busy} onClick={() => void load()}>
                加载最新关联
              </Button>
            </div>
          )}
          {data && (
            <>
              {canWrite ? null : (
                <p className="muted">当前为只读关联，无法新增或解除链接。</p>
              )}
              {targetType === "PROJECT" && (
                <div className="external-links-root">
                  <div className="root-meta">
                    <span className="root-key">项目根仓库</span>
                    {rootRepository ? (
                      <span className="root-value">
                        {repositoryDisplayPath(rootRepository.normalizedUrl)}
                        <span className="root-url">
                          {rootRepository.normalizedUrl}
                        </span>
                      </span>
                    ) : (
                      <span className="root-value root-empty">尚未设置</span>
                    )}
                  </div>
                  <div className="root-actions">
                    {rootRepository && (
                      <a
                        className="root-open"
                        href={rootRepository.normalizedUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        打开
                        <InpulseIcon name="externalLink" size={13} />
                      </a>
                    )}
                    {canWrite && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={addBlocked}
                        onClick={() => {
                          setIsRootRepository(true);
                          setAdding(true);
                        }}
                      >
                        {rootRepository ? "切换" : "设置"}
                      </button>
                    )}
                  </div>
                </div>
              )}
              {data.items.length === 0 ? (
                <div className="external-links-empty">
                  <span className="empty-title">
                    还没有关联任何 GitHub 链接
                  </span>
                  {targetType === "PROJECT" && (
                    <span className="empty-hint">
                      可以先设一个项目根仓库，再补充 PR / Commit / Release
                    </span>
                  )}
                  {canWrite && (
                    <Button
                      type="primary"
                      disabled={addBlocked}
                      onClick={() => setAdding(true)}
                    >
                      <InpulseIcon name="plus" size={14} />
                      添加链接
                    </Button>
                  )}
                </div>
              ) : (
                <>
                  <div className="external-links-head">
                    <span className="head-label">
                      关联链接
                      {linkedItems.length > 0
                        ? " · " + linkedItems.length + " 条"
                        : ""}
                    </span>
                    {canWrite && !adding && removeId === null && (
                      <button
                        type="button"
                        className="external-links-add-trigger"
                        disabled={addBlocked}
                        onClick={() => setAdding(true)}
                      >
                        <InpulseIcon name="plus" size={14} />
                        添加链接
                      </button>
                    )}
                  </div>
                  {linkedItems.length === 0 ? (
                    <p className="muted">
                      还没有其他关联链接，可点「添加链接」补充 PR / Commit /
                      Release。
                    </p>
                  ) : (
                    <ul className="external-links-list">
                      {linkedItems.map((item) => {
                        // 项目视图会把任务 / 功能 / 记录上的链接一并聚合进来，并标注来源。
                        const sourceText = externalLinkSourceText(item);
                        return (
                          <li key={item.id}>
                            <Tag>{externalLinkKindLabel(item)}</Tag>
                            <a
                              className="link-name"
                              href={item.normalizedUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {item.label}
                              <InpulseIcon name="externalLink" size={12} />
                            </a>
                            <span className="link-repo">
                              {item.repository ??
                                repositoryDisplayPath(item.normalizedUrl)}
                            </span>
                            {sourceText !== null && (
                              <span className="link-source" title={sourceText}>
                                {sourceText}
                              </span>
                            )}
                            {canWrite &&
                              canRemoveExternalLink(targetType, item) && (
                                <button
                                  type="button"
                                  className="text-button danger-text link-remove"
                                  disabled={addBlocked}
                                  aria-label={"解除 " + item.label}
                                  onClick={() => setRemoveId(item.id)}
                                >
                                  解除
                                </button>
                              )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {linkedItems.some(
                    (item) => !canRemoveExternalLink("PROJECT", item),
                  ) && (
                    <p className="muted">
                      来自任务 / 功能 / 迭代记录的链接请在各自入口解除关联。
                    </p>
                  )}
                </>
              )}
              {canWrite && adding && addFormFields !== null && (
                <div className="external-links-add">{addFormFields}</div>
              )}
              {canWrite && removeId !== null && (
                <div className="calm-action-footer">
                  <p>确认解除此链接的当前关联？</p>
                  <Button disabled={busy} onClick={() => setRemoveId(null)}>
                    取消解除
                  </Button>
                  <Button
                    danger
                    disabled={addBlocked}
                    onClick={() => void save()}
                  >
                    确认解除关联
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
export function previewLabel(raw: string): string | null {
  const sha = commitShaInput(raw);
  if (sha !== null) return "Commit " + sha.slice(0, 12);
  try {
    const parsed = new URL(raw.trim());
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "github.com" ||
      parsed.username ||
      parsed.password ||
      parsed.port
    )
      return null;
    const parts = parsed.pathname
        .split("/")
        .filter(Boolean)
        .map(decodeURIComponent),
      reference = parts[3];
    if (parts[2] === "issues" && reference && /^[1-9][0-9]*$/.test(reference))
      return "Issue #" + reference;
    if (parts[2] === "pull" && reference && /^[1-9][0-9]*$/.test(reference))
      return "PR #" + reference;
    if (
      parts[2] === "commit" &&
      reference &&
      /^[a-f0-9]{7,64}$/i.test(reference)
    )
      return "Commit " + reference.toLowerCase().slice(0, 12);
    if (parts[2] === "releases" && parts[3] === "tag" && parts[4])
      return "Release " + parts.slice(4).join("/");
    return parts.length >= 2 ? parts[0] + "/" + parts[1] : "GitHub";
  } catch {
    return null;
  }
}
/**
 * 裸 commit SHA（7~64 位十六进制）识别，返回小写形式；
 * 与服务端 `parseCommitShaInput` 同一口径，补全由服务端用项目根仓库完成。
 */
export function commitShaInput(raw: string): string | null {
  const value = raw.trim();
  return /^[a-f0-9]{7,64}$/i.test(value) ? value.toLowerCase() : null;
}
