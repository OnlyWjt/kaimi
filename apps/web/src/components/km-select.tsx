"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type KmSelectOption = {
  value: string;
  label: string;
};

export function KmSelect({
  value,
  onChange,
  options,
  className = "",
  disabled = false,
  placeholder = "请选择",
}: {
  value: string;
  onChange: (value: string) => void;
  options: KmSelectOption[];
  className?: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState({ top: 0, left: 0, width: 0, up: false });
  const selected = options.find((option) => option.value === value);

  function place() {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const up = spaceBelow < 200 && rect.top > spaceBelow;
    setBox({
      top: up ? rect.top - 6 : rect.bottom + 6,
      left: rect.left,
      width: rect.width,
      up,
    });
  }

  useEffect(() => {
    if (!open) return;
    place();
    function onPointer(event: MouseEvent) {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  const menu =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={menuRef}
            id={listId}
            role="listbox"
            className="km-select-menu"
            style={{
              top: box.top,
              left: box.left,
              width: Math.max(box.width, 160),
              transform: box.up ? "translateY(-100%)" : undefined,
            }}
          >
            {options.map((option) => {
              const active = option.value === value;
              return (
                <button
                  key={option.value || "__empty"}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className="km-select-option"
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {active ? <span className="km-select-mark" aria-hidden /> : null}
                </button>
              );
            })}
          </div>,
          document.body,
        )
      : null;

  return (
    <div className={`km-select ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        className="km-input km-select-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          if (disabled) return;
          setOpen((current) => !current);
        }}
      >
        <span className={`min-w-0 truncate ${selected ? "" : "text-[var(--km-fg-muted)]"}`}>
          {selected?.label || placeholder}
        </span>
        <svg className={`km-select-chevron ${open ? "is-open" : ""}`} viewBox="0 0 12 12" aria-hidden>
          <path d="M2.2 4.4 6 8.1l3.8-3.7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {menu}
    </div>
  );
}
