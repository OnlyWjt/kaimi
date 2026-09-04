"use client";

import Link from "next/link";
import {
  ORDER_PIPELINE_STEPS,
  isOrderTerminalStatus,
  normalizeOrderStatus,
  orderStatusLabel,
  pipelineStepIndex,
} from "@/lib/order-status";
import { COARSE_STAGE_KEYS, coarseStageIndex } from "@/lib/redeem-timeline-core";
import { publicStatusLabel } from "@/lib/status-labels";

export type TimelineRow = {
  step?: unknown;
  category?: unknown;
  message?: unknown;
  at?: unknown;
};

export type OrderProgressRow = {
  orderNo?: unknown;
  fulfillStatus?: unknown;
  message?: unknown;
  email?: unknown;
  accountEmail?: unknown;
  codeMasked?: unknown;
  codeLast4?: unknown;
  /** 卡台自己的状态和阶段，和本站的 fulfillStatus 不是一套词。 */
  upstreamStatus?: unknown;
  upstreamStage?: unknown;
  /** 开卡用的银行卡尾号，不是卡密尾号。 */
  cardLastFour?: unknown;
  timeline?: unknown;
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

function formatStamp(iso: string) {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString("zh-CN", { hour12: false });
}

/** 明细每一行的成色。认不出来的分类当作还在跑，不能当成失败。 */
function categoryTone(category: string) {
  if (["success", "completed", "ok"].includes(category)) return "ok" as const;
  if (["failed", "error"].includes(category)) return "bad" as const;
  return "wait" as const;
}

const TONE_COLOR = {
  ok: "var(--km-success)",
  bad: "var(--km-danger)",
  wait: "var(--km-accent)",
} as const;

function normalizeTimeline(value: unknown) {
  if (!Array.isArray(value)) return [];
  return (value as TimelineRow[]).map((row) => ({
    step: String(row.step || "").toLowerCase(),
    category: String(row.category || "").toLowerCase(),
    message: row.message != null ? String(row.message) : "",
    at: String(row.at || ""),
  }));
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

  const upstreamStatus = String(row.upstreamStatus || "").toLowerCase();
  const upstreamStage = String(row.upstreamStage || "").toLowerCase();
  const cardLastFour = String(row.cardLastFour || "");
  const timeline = normalizeTimeline(row.timeline);
  // 卡台给了明细就用卡台的进度条；没给就退回本站那五步，售码单本来也走不到卡台。
  const hasUpstream = timeline.length > 0 || Boolean(upstreamStatus);
  const coarseIdx = coarseStageIndex({
    status: upstreamStatus,
    stage: upstreamStage,
    steps: timeline.map((item) => item.step),
  });

  return (
    <div className="space-y-4 rounded-[var(--km-radius)] border border-[var(--km-border)] bg-[var(--km-bg-muted)]/60 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-xs text-[var(--km-fg-muted)]">开通进度</p>
          {orderNo ? <p className="mt-0.5 font-mono text-sm font-medium">{orderNo}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {hasUpstream && upstreamStage ? (
            <span className="text-xs text-[var(--km-fg-muted)]">
              阶段 {publicStatusLabel(upstreamStage, "redeemStage")}
            </span>
          ) : null}
          {status ? (
            <span className={`km-badge ${success ? "km-badge-ok" : failed ? "km-badge-bad" : "km-badge-wait"}`}>
              {orderStatusLabel(status)}
            </span>
          ) : null}
        </div>
      </div>

      {hasUpstream ? (
        <div className="space-y-1.5 rounded-[var(--km-radius)] bg-[var(--km-bg-elevated)] p-3 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <span className="shrink-0 text-[var(--km-fg-muted)]">兑换账号</span>
            <span className="break-all text-right font-mono">{email || "—"}</span>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <span className="shrink-0 text-[var(--km-fg-muted)]">银行卡</span>
            <span className="font-mono">
              {cardLastFour ? (
                `•••• ${cardLastFour}`
              ) : (
                <span className="text-[var(--km-fg-muted)]">开卡后显示尾号</span>
              )}
            </span>
          </div>
          {codeMasked ? (
            <div className="flex items-baseline justify-between gap-3">
              <span className="shrink-0 text-[var(--km-fg-muted)]">卡密</span>
              <span className="font-mono">{codeMasked}</span>
            </div>
          ) : null}
        </div>
      ) : email || codeMasked || codeLast4 ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--km-fg-muted)]">
          {codeMasked ? <span>卡密 {codeMasked}</span> : codeLast4 ? <span>卡密后四位 {codeLast4}</span> : null}
          {email ? <span>账号 {email}</span> : null}
        </div>
      ) : null}

      {hasUpstream ? (
        <div className="grid grid-cols-2 gap-2 text-center text-xs sm:grid-cols-4">
          {COARSE_STAGE_KEYS.map((key, i) => {
            const active = i <= coarseIdx;
            return (
              <div
                key={key}
                className="rounded-[var(--km-radius)] border px-2 py-2"
                style={{
                  borderColor: active ? "var(--km-accent)" : "var(--km-border)",
                  background: active
                    ? "color-mix(in oklab, var(--km-accent) 10%, transparent)"
                    : undefined,
                  fontWeight: active ? 600 : undefined,
                  color: active ? undefined : "var(--km-fg-muted)",
                }}
              >
                {publicStatusLabel(key, "redeemStage")}
              </div>
            );
          })}
        </div>
      ) : (
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
      )}

      {message ? <p className="text-sm leading-relaxed">{message}</p> : null}

      {timeline.length > 0 ? (
        <div>
          <p className="mb-2 text-sm font-medium">处理明细</p>
          <ol className="space-y-3 border-l-2 border-[var(--km-border)] pl-4">
            {timeline.map((item, i) => {
              const tone = categoryTone(item.category);
              return (
                <li key={`${item.step}-${item.at}-${i}`} className="relative">
                  <span
                    className="absolute -left-[1.32rem] top-1.5 h-2.5 w-2.5 rounded-full"
                    style={{ background: TONE_COLOR[tone] }}
                  />
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-sm font-medium">
                      {publicStatusLabel(item.step, "redeemStep")}
                    </span>
                    <span
                      className={`km-badge ${
                        tone === "ok" ? "km-badge-ok" : tone === "bad" ? "km-badge-bad" : "km-badge-wait"
                      }`}
                    >
                      {publicStatusLabel(item.category || "pending", "redeemEvent")}
                    </span>
                    {item.at ? (
                      <span className="font-mono text-xs text-[var(--km-fg-muted)]">
                        {formatStamp(item.at)}
                      </span>
                    ) : null}
                  </div>
                  {item.message ? (
                    <p className="mt-0.5 text-sm text-[var(--km-fg-muted)]">{item.message}</p>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </div>
      ) : hasUpstream && polling ? (
        <p className="text-sm text-[var(--km-fg-muted)]">已提交，等待卡台返回步骤明细…</p>
      ) : null}

      {/* 卡台明细在的时候本站这条状态流水就是重复信息，只在没有明细时保留。 */}
      {!hasUpstream && events.length > 0 ? (
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

      {terminal && success ? (
        <p className="km-result km-session-pass text-sm">开通完成，请到 ChatGPT 账号确认套餐。</p>
      ) : null}
      {status === "unknown" ? (
        <p className="km-result km-session-fail text-sm">
          结果还在和卡台核对，请不要重复提交。核对完这里会更新。
        </p>
      ) : null}
      {status === "failed" ? (
        <p className="km-result km-session-fail text-sm">
          兑换未成功。可以重新兑换，或联系发码方。
        </p>
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
