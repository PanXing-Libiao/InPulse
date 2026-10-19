import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { InpulseIcon } from "@features/common/components/InpulseIcon";

import { AUDIT_ACTION_OPTIONS } from "./audit-labels";

const LISTBOX_ID = "audit-action-options";
const optionId = (index: number) => "audit-action-option-" + index;

/** 按原始码或中文标签过滤候选；空输入展示全部候选。 */
function filterActionOptions(value: string) {
  const query = value.trim().toLocaleLowerCase();
  if (query === "") return AUDIT_ACTION_OPTIONS;
  return AUDIT_ACTION_OPTIONS.filter(
    (option) =>
      option.code.toLocaleLowerCase().includes(query) ||
      option.label.toLocaleLowerCase().includes(query),
  );
}

export interface AuditActionFilterProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
}

export const AuditActionFilter: React.FC<AuditActionFilterProps> = ({
  value,
  onChange,
}) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const options = useMemo(() => filterActionOptions(value), [value]);
  const activeOption = options[activeIndex];

  useEffect(() => {
    if (open) {
      optionRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
    }
  }, [activeIndex, open]);

  const choose = useCallback(
    (code: string) => {
      onChange(code);
      setOpen(false);
      setActiveIndex(0);
      inputRef.current?.focus();
    },
    [onChange],
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActiveIndex(0);
        return;
      }
      setActiveIndex((current) =>
        options.length === 0 ? 0 : (current + 1) % options.length,
      );
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActiveIndex(0);
        return;
      }
      setActiveIndex((current) =>
        options.length === 0
          ? 0
          : (current - 1 + options.length) % options.length,
      );
      return;
    }
    if (event.key === "Enter" && open && activeOption !== undefined) {
      event.preventDefault();
      choose(activeOption.code);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className="task-search audit-action-search">
      <InpulseIcon name="search" size={16} />
      <input
        ref={inputRef}
        value={value}
        placeholder="动作：选择或输入原始动作码"
        aria-label="动作码"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        {...(open ? { "aria-controls": LISTBOX_ID } : {})}
        {...(open && activeOption !== undefined
          ? { "aria-activedescendant": optionId(activeIndex) }
          : {})}
        onChange={(event) => {
          const next = event.currentTarget.value;
          onChange(next);
          setActiveIndex(0);
          const matches = filterActionOptions(next);
          const trimmed = next.trim().toLocaleLowerCase();
          const exactCodeMatch =
            matches.length === 1 &&
            matches[0]?.code.toLocaleLowerCase() === trimmed;
          setOpen(matches.length > 0 && !exactCodeMatch);
        }}
        onFocus={() => {
          setOpen(true);
          setActiveIndex(0);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={handleKeyDown}
      />
      <button
        type="button"
        className="audit-action-toggle"
        aria-label={open ? "收起动作码候选" : "展开动作码候选"}
        aria-expanded={open}
        {...(open ? { "aria-controls": LISTBOX_ID } : {})}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          const next = !open;
          setOpen(next);
          setActiveIndex(0);
          inputRef.current?.focus();
        }}
      >
        <InpulseIcon name="chevronDown" size={14} />
      </button>
      {open ? (
        <div
          id={LISTBOX_ID}
          role="listbox"
          aria-label="动作码候选"
          className="audit-action-options"
          onMouseDown={(event) => event.preventDefault()}
        >
          {options.length === 0 ? (
            <div className="audit-action-empty">
              没有匹配的动作码，可直接查询当前输入
            </div>
          ) : (
            options.map((option, index) => (
              <div
                key={option.code}
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                id={optionId(index)}
                role="option"
                data-code={option.code}
                aria-selected={option.code === value}
                className={
                  "audit-action-option" +
                  (index === activeIndex ? " is-active" : "")
                }
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(option.code)}
              >
                <strong>{option.code}</strong>
                <span>{option.label}</span>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
};
