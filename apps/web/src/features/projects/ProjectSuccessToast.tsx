import React, { useEffect, useRef } from "react";
import { InpulseIcon } from "@features/common/components/InpulseIcon";

/** 项目创建/变更成功提示的停留时间：既要能扫到结果，也不能长期占住页面。 */
export const PROJECT_SUCCESS_NOTICE_DURATION_MS = 6000;

export interface ProjectSuccessToastProps {
  readonly testId: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly actions?: React.ReactNode | undefined;
  readonly onDismiss?: (() => void) | undefined;
}

/**
 * 项目级成功气泡：固定浮层、不挤占页面布局，并由组件统一负责自动关闭。
 * 成功结果只保留一个，后到的变更会替换创建提示，避免横向横幅一直堆叠。
 */
export const ProjectSuccessToast: React.FC<ProjectSuccessToastProps> = ({
  testId,
  title,
  description,
  actions,
  onDismiss,
}) => {
  const onDismissRef = useRef(onDismiss);
  const dismissible = onDismiss !== undefined;

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!dismissible) return;
    const timeout = window.setTimeout(
      () => onDismissRef.current?.(),
      PROJECT_SUCCESS_NOTICE_DURATION_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [dismissible]);

  return (
    <div
      className="creation-success project-success-toast"
      data-testid={testId}
      role="status"
      aria-live="polite"
    >
      <div className="creation-success-icon">
        <InpulseIcon name="check" size={18} />
      </div>
      <div className="creation-success-body">
        <strong>{title}</strong>
        {description ? <span>{description}</span> : null}
        {actions ? (
          <div className="creation-success-actions">{actions}</div>
        ) : null}
      </div>
      {onDismiss ? (
        <button
          type="button"
          className="project-success-toast-close"
          aria-label="关闭成功提示"
          onClick={onDismiss}
        >
          ×
        </button>
      ) : null}
    </div>
  );
};
