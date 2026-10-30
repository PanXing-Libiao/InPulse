import React from "react";
import { Button } from "antd";
import { InpulseIcon } from "@features/common/components/InpulseIcon";

/**
 * 两步齐备（模块、任务各有至少一条记录）后，搭建引导整体隐藏。
 * 计数由调用方从模块列表的既有统计聚合，引导本身不新增任何请求。
 */
export function isProjectSetupComplete(
  moduleCount: number,
  taskCount: number,
): boolean {
  return moduleCount > 0 && taskCount > 0;
}

export interface ProjectSetupGuideInput {
  readonly moduleCount: number;
  readonly taskCount: number;
  readonly onCreateModule: () => void;
  /**
   * 「从文档导入」（ADR-064）：空项目没有模块区块入口时，引导头部提供导入
   * 入口；已有模块时由模块区块标题行的按钮承担，调用方传 undefined。
   */
  readonly onImportDocument?: (() => void) | undefined;
}

export interface ProjectSetupGuideProps extends ProjectSetupGuideInput {
  readonly onCreateTask: () => void;
}

interface SetupStep {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly done: boolean;
  readonly doneLabel: string;
  readonly action: { readonly label: string; readonly run: () => void } | null;
  readonly hint: string | null;
}

function renderStepAction(step: SetupStep, current: boolean): React.ReactNode {
  if (step.done) {
    return (
      <span className="project-setup-step-done">已完成 · {step.doneLabel}</span>
    );
  }
  if (step.action === null) {
    return <span className="project-setup-step-hint">{step.hint}</span>;
  }
  return (
    <Button
      className={current ? "primary-button" : "soft-blue-button"}
      onClick={step.action.run}
    >
      {step.action.label}
    </Button>
  );
}

/**
 * 新项目搭建引导（ADR-109）：按「模块 → 任务」两段建立第一条业务链路，
 * 两步齐备后引导自动隐藏；每一步都给出直达对应创建入口的动作。
 */
export const ProjectSetupGuide: React.FC<ProjectSetupGuideProps> = ({
  moduleCount,
  taskCount,
  onCreateModule,
  onCreateTask,
  onImportDocument,
}) => {
  if (isProjectSetupComplete(moduleCount, taskCount)) {
    return null;
  }
  const hasModule = moduleCount > 0;
  const steps: readonly SetupStep[] = [
    {
      key: "module",
      title: "建立模块",
      description: "模块负责业务分类，例如「支付」「订单」。",
      done: moduleCount > 0,
      doneLabel: moduleCount + " 个模块",
      action: { label: "新增模块", run: onCreateModule },
      hint: null,
    },
    {
      key: "task",
      title: "创建任务",
      description: "任务是指派给成员的具体工作，完成后可沉淀迭代记录。",
      done: taskCount > 0,
      doneLabel: taskCount + " 项任务",
      action: hasModule ? { label: "创建任务", run: onCreateTask } : null,
      hint: hasModule ? null : "先完成第 1 步",
    },
  ];
  const currentIndex = steps.findIndex((step) => !step.done);
  return (
    <section
      className="project-setup-guide"
      aria-label="新项目搭建引导"
      data-testid="project-setup-guide"
    >
      <div className="project-setup-guide-head">
        <div>
          <h2>开始搭建这个项目</h2>
          <p>
            按「模块 → 任务」的顺序建立第一条业务链路，两步齐备后引导自动隐藏。
          </p>
        </div>
        {onImportDocument !== undefined && moduleCount === 0 ? (
          <Button
            className="secondary-button"
            data-testid="import-project-document-from-guide-button"
            onClick={onImportDocument}
          >
            <InpulseIcon name="fileText" size={15} />
            从文档导入
          </Button>
        ) : null}
      </div>
      <ol className="project-setup-steps">
        {steps.map((step, index) => {
          let className = "project-setup-step";
          if (step.done) className += " is-done";
          else if (step.action === null) className += " is-blocked";
          else if (index === currentIndex) className += " is-current";
          return (
            <li
              key={step.key}
              className={className}
              data-testid={"setup-step-" + step.key}
            >
              <span className="project-setup-step-mark" aria-hidden="true">
                {step.done ? <InpulseIcon name="check" size={14} /> : index + 1}
              </span>
              <div className="project-setup-step-body">
                <strong>{step.title}</strong>
                <p>{step.description}</p>
              </div>
              {renderStepAction(step, index === currentIndex)}
            </li>
          );
        })}
      </ol>
    </section>
  );
};
