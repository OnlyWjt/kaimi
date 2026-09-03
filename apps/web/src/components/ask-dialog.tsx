"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type AskField = {
  name: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
  hint?: string;
  required?: boolean;
  /** 必须原样输入这个值才放行，用于危险操作的二次确认。 */
  mustEqual?: string;
};

export type AskAction = {
  name: string;
  label: string;
  danger?: boolean;
};

export type AskOptions = {
  title: string;
  message?: string;
  fields?: AskField[];
  /** 给多于一种走法的操作用，每个按钮回一个 __action，别再拿「确定/取消」当两个选项。 */
  actions?: AskAction[];
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

type Pending = {
  options: AskOptions;
  resolve: (value: Record<string, string> | null) => void;
};

/**
 * 替掉浏览器原生 confirm / prompt：原生弹窗没法套主题，还会把地址栏和端口号显示给用户。
 * 用法保持一样好写：`const answer = await ask({...}); if (!answer) return;`
 * 没有 fields 时就是纯确认框，返回空对象代表点了确定。
 */
export function useAskDialog() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const pendingRef = useRef<Pending | null>(null);

  const settle = useCallback((value: Record<string, string> | null) => {
    pendingRef.current?.resolve(value);
    pendingRef.current = null;
    setPending(null);
    setError("");
  }, []);

  const ask = useCallback((options: AskOptions) => {
    return new Promise<Record<string, string> | null>((resolve) => {
      // 上一个还没关就当取消，别让它的 promise 一直悬着。
      pendingRef.current?.resolve(null);
      const next: Pending = { options, resolve };
      pendingRef.current = next;
      setValues(
        Object.fromEntries(
          (options.fields ?? []).map((field) => [
            field.name,
            field.defaultValue ?? "",
          ]),
        ),
      );
      setError("");
      setPending(next);
    });
  }, []);

  useEffect(() => {
    if (!pending) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") settle(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pending, settle]);

  function submit(action = "confirm") {
    if (!pending) return;
    const fields = pending.options.fields ?? [];
    for (const field of fields) {
      const value = (values[field.name] ?? "").trim();
      if (field.required && !value) {
        setError(`请填写「${field.label}」`);
        return;
      }
      if (field.mustEqual !== undefined && value !== field.mustEqual) {
        setError(`「${field.label}」需要原样输入 ${field.mustEqual}`);
        return;
      }
    }
    settle({
      ...Object.fromEntries(
        fields.map((field) => [field.name, (values[field.name] ?? "").trim()]),
      ),
      __action: action,
    });
  }

  const fields = pending?.options.fields ?? [];
  const dialog = pending ? (
    <div className="km-modal-backdrop" onClick={() => settle(null)}>
      <div
        className="km-modal km-modal-ask"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="km-ask-title"
      >
        <h2 id="km-ask-title" className="text-lg font-semibold">
          {pending.options.title}
        </h2>
        {pending.options.message ? (
          <p className="mt-2 whitespace-pre-line text-sm text-[var(--km-fg-muted)]">
            {pending.options.message}
          </p>
        ) : null}
        {fields.length ? (
          <div className="mt-4 space-y-3">
            {fields.map((field, index) => (
              <label key={field.name} className="block space-y-1 text-sm">
                <span>{field.label}</span>
                <input
                  className="km-input w-full"
                  autoFocus={index === 0}
                  placeholder={field.placeholder}
                  value={values[field.name] ?? ""}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [field.name]: event.target.value,
                    }))
                  }
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    // 多按钮的场景没有默认走法，必须让人自己点。
                    if (!pending.options.actions?.length) submit();
                  }}
                />
                {field.hint ? (
                  <span className="text-xs text-[var(--km-fg-muted)]">
                    {field.hint}
                  </span>
                ) : null}
              </label>
            ))}
          </div>
        ) : null}
        {error ? (
          <p className="mt-3 text-sm text-[var(--km-danger)]">{error}</p>
        ) : null}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="km-btn km-btn-ghost"
            onClick={() => settle(null)}
          >
            {pending.options.cancelLabel || "取消"}
          </button>
          {pending.options.actions?.length ? (
            pending.options.actions.map((action) => (
              <button
                key={action.name}
                type="button"
                className={action.danger ? "km-btn km-btn-danger" : "km-btn"}
                onClick={() => submit(action.name)}
              >
                {action.label}
              </button>
            ))
          ) : (
            <button
              type="button"
              className={
                pending.options.danger ? "km-btn km-btn-danger" : "km-btn"
              }
              autoFocus={fields.length === 0}
              onClick={() => submit()}
            >
              {pending.options.confirmLabel || "确定"}
            </button>
          )}
        </div>
      </div>
    </div>
  ) : null;

  return { ask, dialog };
}
