import React, { useEffect, useRef, useState } from "react";
import { Alert, Button, Input } from "antd";
import { AppModal as Modal } from "@features/common/components/AppModal";
import { CatalogItemDeletionConfirm } from "@features/common/components/CatalogItemDeletionConfirm";
import { InpulseIcon } from "@features/common/components/InpulseIcon";
import { useAuth } from "@features/auth/auth-context";
import {
  canDeleteCatalogItem,
  useProjectDetail,
} from "@features/projects/project-query";
import { Controller, useForm } from "react-hook-form";
import {
  ApiError,
  type InpulseApiClient,
  type ModuleItem,
} from "@generated/api";
import {
  moduleErrorMessage,
  useDeleteModule,
  useModules,
  type ModuleChange,
} from "./module-query";

type Values = { name: string; description: string };
const editableFields = ["name", "description"] as const;
type EditableField = (typeof editableFields)[number];
const fieldLabels = { name: "模块名称", description: "模块说明" };
type Merge = {
  base: ModuleItem;
  draft: Values;
  latest: ModuleItem;
  values: Values;
  conflicts: EditableField[];
  choices: Partial<Record<EditableField, "draft" | "latest">>;
};

/** 一次模块编辑请求；`null` 表示弹层关闭。 */
export type ModuleEditorRequest = {
  readonly action: ModuleChange["action"];
  readonly item?: ModuleItem;
};

/**
 * 模块编辑器弹层：新增与编辑共用同一份表单与冲突处理。模块列表页（模块卡
 * 「编辑模块」）与模块详情页头部（设计师稿 catalog.tsx L55-60）都复用本组件，
 * 避免两处实现出现漂移；动作选择由宿主页面通过 `request` 驱动。
 * ADR-044：模块层面已下线归档，弹层不再有归档/恢复动作与操作原因。
 * ADR-096：编辑态弹层页脚最左侧有「删除模块」（仅系统管理员与本项目组长、且
 * 非未分类模块），二次确认后由服务端物理级联删除下级功能、任务与记录。
 */
export function ModuleEditorModal({
  projectId,
  client,
  projectName,
  request,
  onClose,
  onSaved,
  onDeleted,
}: {
  projectId: number;
  client?: InpulseApiClient | undefined;
  projectName: string | null;
  request: ModuleEditorRequest | null;
  onClose: () => void;
  onSaved?: (() => void) | undefined;
  /** 删除成功后的宿主回调：模块详情页需要离开本模块（它已经不存在了）。 */
  onDeleted?: (() => void) | undefined;
}) {
  const { query, mutation } = useModules(projectId, client);
  const deletion = useDeleteModule(projectId, client);
  const { user } = useAuth();
  // 本项目实时角色：与宿主页面读同一份 `["projects", "detail", projectId]` 缓存，
  // 不会因为弹窗多一次请求；角色变更后失效重取，删除入口随之开关。
  const projectDetail = useProjectDetail({ client, projectId });
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [merge, setMerge] = useState<Merge | null>(null);
  // 正在编辑的模块快照：合并冲突或重新拉取最新版本后，`If-Match` 必须用最新
  // 行版本，所以基准项要能被更新，不能一直用打开弹层那一刻的旧快照。
  const [baseItem, setBaseItem] = useState<ModuleItem | undefined>(
    request?.item,
  );
  const editGeneration = useRef(0);
  const submitting = useRef(false);
  const {
    control,
    handleSubmit,
    reset,
    getValues,
    formState: { errors },
  } = useForm<Values>({
    defaultValues: { name: "", description: "" },
  });
  const selection: {
    action: ModuleChange["action"];
    item?: ModuleItem;
  } | null =
    request === null
      ? null
      : { action: request.action, ...(baseItem ? { item: baseItem } : {}) };

  // 每次动作切换（含同一模块的重开）都要回到干净状态：
  // 重排编辑代数以丢弃过期的 reload 结果，并清空上一次的冲突与错误。
  const requestKey =
    request === null
      ? null
      : request.action + ":" + (request.item ? request.item.id : "new");
  useEffect(() => {
    if (request === null) return;
    editGeneration.current += 1;
    setMerge(null);
    setDeleteOpen(false);
    setBaseItem(request.item);
    setReloadError(null);
    setReloading(false);
    mutation.reset();
    reset({
      name: request.item?.name ?? "",
      description: request.item?.description ?? "",
    });
    // 依赖只取 requestKey：mutation 与 reset 是 react-query / react-hook-form
    // 的稳定引用，按下标展开不会带来额外的重跑。
  }, [requestKey]);

  const close = () => {
    if (submitting.current) return;
    editGeneration.current += 1;
    setMerge(null);
    setDeleteOpen(false);
    onClose();
  };
  const save = handleSubmit(async (values) => {
    if (
      !selection ||
      submitting.current ||
      reloading ||
      merge ||
      conflict ||
      reloadError
    )
      return;
    submitting.current = true;
    try {
      await mutation.mutateAsync({ ...selection, ...values });
      onClose();
      onSaved?.();
    } catch {
      /* Mutation retains the error and form remains mounted. */
    } finally {
      submitting.current = false;
    }
  });
  const reload = async () => {
    const generation = editGeneration.current;
    const draft = getValues();
    setReloading(true);
    try {
      const latest = await query.refetch();
      if (generation !== editGeneration.current) return;
      if (latest.error) {
        setReloadError(moduleErrorMessage(latest.error));
        return;
      }
      if (selection?.item) {
        const item = latest.data?.items.find(
          (value) => value.id === selection.item!.id,
        );
        if (!item) {
          setReloadError("模块已不可访问，请取消编辑。");
          return;
        }
        if (selection.action === "update") {
          const values = { ...draft };
          const conflicts: EditableField[] = [];
          for (const field of editableFields) {
            // Compare the name as the request schema normalizes it.
            const normalize = (value: string) =>
              field === "name" ? value.trim() : value;
            const original = normalize(selection.item[field]);
            const mine = normalize(draft[field]);
            const theirs = normalize(item[field]);
            if (mine === original) values[field] = item[field];
            else if (theirs !== original && mine !== theirs)
              conflicts.push(field);
          }
          if (conflicts.length) {
            setMerge({
              base: selection.item,
              draft,
              latest: item,
              values,
              conflicts,
              choices: {},
            });
            setReloadError(null);
            return;
          }
          reset(values);
        }
        setBaseItem(item);
      }
      mutation.reset();
      setReloadError(null);
    } finally {
      setReloading(false);
    }
  };
  const applyMerge = () => {
    if (
      !merge ||
      !selection ||
      merge.conflicts.some((field) => !merge.choices[field])
    )
      return;
    const values = { ...merge.values };
    for (const field of merge.conflicts) {
      values[field] =
        merge.choices[field] === "draft"
          ? merge.draft[field]
          : merge.latest[field];
    }
    reset(values);
    setBaseItem(merge.latest);
    setMerge(null);
    mutation.reset();
  };
  const conflict =
    mutation.error instanceof ApiError && mutation.error.status === 409;
  const modalTitle = selection?.action === "create" ? "新增模块" : "编辑模块";
  /**
   * ADR-096：删除入口的显示条件——编辑态、非未分类模块、系统管理员或本项目组长。
   * 未分类模块在数据库层受保护（服务端 409 `MODULE_UNCLASSIFIED_PROTECTED`，
   * 且 `modules_protect_unclassified` 继续禁止物理删除），前端连入口都不渲染。
   */
  const deleteTarget =
    selection?.action === "update" &&
    selection.item !== undefined &&
    selection.item.kind === "NORMAL" &&
    canDeleteCatalogItem(
      user?.isAdmin === true,
      projectDetail.data?.currentUserRole ?? null,
    )
      ? selection.item
      : undefined;
  /**
   * ADR-096：删除影响面文案。计数取列表已有的 `stats`（未完成 / 已完成用的是与
   * 项目卡、模块卡同一口径的有效任务），不为此新增预览接口；删除范围比这几个
   * 计数宽（已取消任务也随模块永久删除），所以文案里点明「全部任务」。
   */
  const deletionImpact = (item: ModuleItem): string => {
    const features = item.stats.activeFeatureCount;
    const open = item.stats.openTaskCount;
    const done = item.stats.completedTaskCount;
    if (features === 0 && open === 0 && done === 0)
      return "该模块下没有功能，也没有未完成或已完成的任务：确认删除只影响模块自身。";
    return (
      "该模块下有 " +
      features +
      " 个功能、" +
      open +
      " 项未完成任务与 " +
      done +
      " 项已完成任务：确认删除会永久删除该模块、其下这些功能与它们名下的全部任务（无论未完成、已完成还是已取消），以及这些实体的全部迭代记录、版本、遗留项与 GitHub 链接关联。仅保留审计日志与项目动态。"
    );
  };
  const openDeletion = () => {
    if (deleteTarget === undefined || mutation.isPending || reloading || merge)
      return;
    deletion.reset();
    setDeleteOpen(true);
  };
  /**
   * ADR-096：删除模块。服务端在同一事务内物理级联删除下级功能、任务与记录；成功后同时关闭
   * 编辑弹窗与确认弹窗，并由宿主决定离开页面（模块详情页已经不存在了）。
   */
  const confirmDeletion = () => {
    if (deleteTarget === undefined || deletion.isPending) return;
    deletion.mutate(
      { id: deleteTarget.id, rowVersion: deleteTarget.rowVersion },
      {
        onSuccess: () => {
          setDeleteOpen(false);
          onClose();
          onDeleted?.();
        },
      },
    );
  };
  return (
    <>
      <Modal
        open={selection !== null}
        className="catalog-modal"
        eyebrow={projectName}
        title={modalTitle}
        onCancel={close}
        mask={{ closable: !mutation.isPending }}
      >
        <form
          className="catalog-form calm-form"
          onSubmit={(event) => void save(event)}
        >
          <div className="dialog-form">
            <div className="calm-field">
              <label htmlFor="module-name">模块名称</label>
              <Controller
                name="name"
                control={control}
                rules={{
                  validate: (v) => v.trim().length > 0 || "请填写模块名称",
                  maxLength: { value: 200, message: "名称最多 200 字" },
                }}
                render={({ field }) => (
                  <Input
                    {...field}
                    id="module-name"
                    disabled={mutation.isPending || reloading || !!merge}
                  />
                )}
              />
              <p role="alert">{errors.name?.message}</p>
            </div>
            <div className="calm-field">
              <label htmlFor="module-description">模块说明</label>
              <Controller
                name="description"
                control={control}
                rules={{
                  maxLength: { value: 20000, message: "说明最多 20000 字" },
                }}
                render={({ field }) => (
                  <Input.TextArea
                    {...field}
                    id="module-description"
                    rows={5}
                    disabled={mutation.isPending || reloading || !!merge}
                  />
                )}
              />
              <p role="alert">{errors.description?.message}</p>
            </div>
            {mutation.isError && (
              <Alert type="error" title={moduleErrorMessage(mutation.error)} />
            )}
            {reloadError && <Alert type="error" title={reloadError} />}
            {merge && (
              <section className="merge-panel" aria-label="解决编辑冲突">
                <div className="calm-section-title">
                  <h3>解决编辑冲突</h3>
                </div>
                {merge.conflicts.map((field) => (
                  <div className="merge-choice" key={field}>
                    <h3>{fieldLabels[field]}存在冲突</h3>
                    <dl
                      style={{
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                      }}
                    >
                      <dt>编辑前</dt>
                      <dd>{merge.base[field] || "（空）"}</dd>
                      <dt>我的草稿</dt>
                      <dd>{merge.draft[field] || "（空）"}</dd>
                      <dt>服务端最新</dt>
                      <dd>{merge.latest[field] || "（空）"}</dd>
                    </dl>
                    <div className="catalog-actions">
                      <Button
                        className="secondary-button"
                        aria-pressed={merge.choices[field] === "draft"}
                        onClick={() =>
                          setMerge({
                            ...merge,
                            choices: { ...merge.choices, [field]: "draft" },
                          })
                        }
                      >
                        保留我的{fieldLabels[field]}
                      </Button>
                      <Button
                        className="secondary-button"
                        aria-pressed={merge.choices[field] === "latest"}
                        onClick={() =>
                          setMerge({
                            ...merge,
                            choices: { ...merge.choices, [field]: "latest" },
                          })
                        }
                      >
                        采用最新{fieldLabels[field]}
                      </Button>
                    </div>
                  </div>
                ))}
                <Button
                  className="primary-button"
                  disabled={merge.conflicts.some(
                    (field) => !merge.choices[field],
                  )}
                  onClick={applyMerge}
                >
                  应用合并结果
                </Button>
              </section>
            )}
            {conflict && !merge && (
              <Button
                className="secondary-button"
                loading={reloading}
                onClick={() => void reload()}
              >
                加载最新版本后继续编辑
              </Button>
            )}
          </div>
          <div className="calm-action-footer">
            {deleteTarget ? (
              // ADR-096：与「删除任务」同一形态，页脚最左侧的危险动作，
              // 确认弹层在编辑弹窗之外单独渲染（见下方 CatalogItemDeletionConfirm）。
              <div className="footer-leading">
                <Button
                  className="tint-danger-button"
                  disabled={
                    mutation.isPending ||
                    reloading ||
                    !!merge ||
                    deletion.isPending
                  }
                  onClick={openDeletion}
                >
                  <InpulseIcon name="alert" size={15} />
                  删除模块
                </Button>
              </div>
            ) : null}
            <Button
              className="secondary-button"
              onClick={close}
              disabled={mutation.isPending}
            >
              取消
            </Button>
            <Button
              className="primary-button"
              htmlType="submit"
              loading={mutation.isPending}
              disabled={reloading || conflict || !!reloadError || !!merge}
            >
              保存
            </Button>
          </div>
        </form>
      </Modal>
      {/* 删除确认必须在编辑弹窗**之外**：rc-dialog 会 memo 化编辑弹窗的 children，
          挂在子树内的确认弹层拿不到 open / pending 更新，删除成功后会一直转圈并卡住。 */}
      <CatalogItemDeletionConfirm
        noun="模块"
        open={deleteOpen}
        name={deleteTarget?.name}
        code={deleteTarget?.code}
        impact={deleteTarget ? deletionImpact(deleteTarget) : ""}
        pending={deletion.isPending}
        error={deletion.error}
        testId="confirm-delete-module"
        onCancel={() => {
          if (!deletion.isPending) setDeleteOpen(false);
        }}
        onConfirm={confirmDeletion}
      />
    </>
  );
}
