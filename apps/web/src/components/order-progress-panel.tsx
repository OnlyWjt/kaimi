"use client";

import Link from "next/link";
import {
  ORDER_PIPELINE_STEPS,
  isOrderTerminalStatus,
  normalizeOrderStatus,
  orderStatusLabel,
  pipelineStepIndex,
} from "@/lib/order-status";

export type OrderProgressRow = {
  orderNo?: unknown;
  fulfillStatus?: unknown;
  message?: unknown;
  email?: unknown;
  accountEmail?: unknown;
  codeMasked?: unknown;
  codeLast4?: unknown;
};

export type ProgressEvent = {
  status: string;
  message: string;
  at: string;
};

function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

export function OrderProgressPanel({
  row,
  polling = false,
  showLookupLink = false,
  events = [],
}: {
  row: OrderProgressRow;
  polling?: boolean;
  showLookupLink?: boolean;
  events?: ProgressEvent[];
}) {
  const orderNo = String(row.orderNo || "");
  const status = normalizeOrderStatus(String(row.fulfillStatus || ""));
  const message = row.message != null ? String(row.message) : "";
  const email = String(row.accountEmail || row.email || "");
  const codeMasked = String(row.codeMasked || "");
  const codeLast4 = String(row.codeLast4 || "");
  const stepIdx = status ? pipelineStepIndex(status) : -1;
  const terminal = status ? isOrderTerminalStatus(status) : false;
  const success = status === "success" || status === "skipped" || status === "fulfilled";
  const failed = status === "failed" || status === "unknown";

  return (
    <div className="space-y-4 rounded-[var(--km-radius)] border border-[var(--km-border)] bg-[var(--km-bg-muted)]/60 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-xs text-[var(--km-fg-muted)]">开通进度</p>
          {orderNo ? <p className="mt-0.5 font-mono text-sm font-medium">{orderNo}</p> : null}
        </div>
        {status ? (
          <span className={`km-badge ${success ? "km-badge-ok" : failed ? "km-badge-bad" : "km-badge-wait"}`}>
            {orderStatusLabel(status)}
          </span>
        ) : null}
      </div>

      {email || codeMasked || codeLast4 ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--km-fg-muted)]">
          {codeMasked ? <span>卡密 {codeMasked}</span> : codeLast4 ? <span>卡密后四位 {codeLast4}</span> : null}
          {email ? <span>账号 {email}</span> : null}
        </div>
      ) : null}

      <ol className="space-y-0">
        {ORDER_PIPELINE_STEPS.map((step, i) => {
          const done = stepIdx > i || (terminal && success);
          const current = !terminal && stepIdx === i;
          return (
            <li key={step} className="flex gap-3">
              <div className="flex w-5 flex-col items-center">
                <span
                  className="mt-1 h-2.5 w-2.5 rounded-full"
                  style={{
                    background: done || current ? "var(--km-accent)" : "var(--km-border)",
                    boxShadow: current
                      ? "0 0 0 3px color-mix(in oklab, var(--km-accent) 28%, transparent)"
                      : undefined,
                  }}
                />
                {i < ORDER_PIPELINE_STEPS.length - 1 ? (
                  <span
                    className="my-0.5 min-h-4 w-px flex-1"
                    style={{ background: done ? "var(--km-accent)" : "var(--km-border)" }}
                  />
                ) : null}
              </div>
              <div
                className={`pb-3 text-sm ${current ? "font-medium" : done ? "" : "text-[var(--km-fg-muted)]"}`}
              >
                {orderStatusLabel(step)}
                {current && polling ? (
                  <span className="ml-2 text-xs font-normal text-[var(--km-fg-muted)]">进行中…</span>
                ) : null}
              </div>
            </li>
          );
        })}
        <li className="flex gap-3">
          <div className="flex w-5 flex-col items-center">
            <span
              className="mt-1 h-2.5 w-2.5 rounded-full"
              style={{
                background: terminal
                  ? success
                    ? "var(--km-success)"
                    : "var(--km-danger)"
                  : "var(--km-border)",
              }}
            />
          </div>
          <div
            className={`text-sm ${terminal ? "font-medium" : "text-[var(--km-fg-muted)]"}`}
            style={terminal ? { color: success ? "var(--km-success)" : "var(--km-danger)" } : undefined}
          >
            {terminal ? orderStatusLabel(status) : "开通结果"}
          </div>
        </li>
      </ol>

      {message ? <p className="text-sm leading-relaxed">{message}</p> : null}

      {events.length > 0 ? (
        <div className="border-t border-[var(--km-border)] pt-3">
          <p className="mb-2 text-xs text-[var(--km-fg-muted)]">实时更新</p>
          <ul className="max-h-40 space-y-2 overflow-y-auto text-xs">
            {[...events].reverse().map((ev, i) => (
              <li key={`${ev.at}-${ev.status}-${i}`} className="flex gap-2">
                <span className="shrink-0 font-mono text-[var(--km-fg-muted)]">{formatTime(ev.at)}</span>
                <span className="font-medium">{orderStatusLabel(ev.status)}</span>
                {ev.message ? <span className="text-[var(--km-fg-muted)]">{ev.message}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {polling && status && !terminal ? (
        <p className="text-xs text-[var(--km-fg-muted)]">进度更新中…</p>
      ) : null}
      {showLookupLink && orderNo ? (
        <Link className="inline-block text-sm underline" href={`/lookup?orderNo=${encodeURIComponent(orderNo)}`}>
          在订单进度页打开
        </Link>
      ) : null}
    </div>
  );
}
