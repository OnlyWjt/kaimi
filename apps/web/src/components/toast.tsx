"use client";

import { useEffect, useState } from "react";

export type ToastKind = "ok" | "err" | "info";

type ToastItem = {
  id: number;
  kind: ToastKind;
  text: string;
};

type Listener = (items: ToastItem[]) => void;

let seq = 0;
let items: ToastItem[] = [];
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener(items);
}

function dismiss(id: number) {
  items = items.filter((item) => item.id !== id);
  emit();
}

export function toast(text: string, kind: ToastKind = "ok") {
  const value = text.trim();
  if (!value) return;
  const item: ToastItem = { id: ++seq, kind, text: value };
  items = [...items.filter((current) => current.text !== value), item].slice(-4);
  emit();
  window.setTimeout(() => dismiss(item.id), kind === "err" ? 8000 : 3800);
}

export function ToastHost() {
  const [list, setList] = useState<ToastItem[]>(items);

  useEffect(() => {
    listeners.add(setList);
    setList(items);
    return () => {
      listeners.delete(setList);
    };
  }, []);

  if (list.length === 0) return null;

  return (
    <div className="km-toast-stack" role="status" aria-live="polite">
      {list.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`km-toast km-toast-${item.kind}`}
          onClick={() => dismiss(item.id)}
        >
          <span className="km-toast-label">
            {item.kind === "err" ? "失败" : item.kind === "info" ? "提示" : "完成"}
          </span>
          <span className="km-toast-text">{item.text}</span>
        </button>
      ))}
    </div>
  );
}
