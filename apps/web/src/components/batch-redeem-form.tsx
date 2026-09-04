"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAskDialog } from "@/components/ask-dialog";
import { toast } from "@/components/toast";
import { copyText } from "@/lib/copy-text";
import {
  batchRowIsCommitted,
  batchRowStateFromOrder,
  batchSubmitFailureState,
  canRetryBatchRow,
  takeRedeemCodes,
  type BatchRowState,
} from "@/lib/recharge-batch-core";
import { publicStatusLabel } from "@/lib/status-labels";

type Row = {
  code: string;
  codeMasked: string;
  state: BatchRowState;
  planName: string;
  message: string;
  orderNo: string;
  accountEmail: string;
};

type ValidateRow = {
  code: string;
  codeMasked: string;
  ok: boolean;
  planKey: string;
  planName: string;
  orderNo: string;
  error: string;
};

type SubmitRow = {
  code: string;
  ok: boolean;
  orderNo: string;
  error: string;
};

type StatusRow = {
  orderNo: string;
  fulfillStatus: string;
  message: string;
  accountEmail: string;
};

type SessionPreview = {
  ok: boolean;
  email?: string;
  name?: string;
  errors?: string[];
  warnings?: string[];
  source?: string;
  error?: string;
};

function badgeClass(state: BatchRowState) {
  if (state === "success") return "km-badge km-badge-ok";
  if (state === "failed" || state === "invalid") return "km-badge km-badge-bad";
  return "km-badge km-badge-wait";
}

export function BatchRedeemForm({
  limit,
  orderRef,
}: {
  limit: number;
  /** 从多张卡的购买订单跳进来时，卡密由这里去订单接口取，不走地址栏。 */
  orderRef?: { orderNo: string; queryToken: string };
}) {
  const { ask, dialog } = useAskDialog();
  const [codeText, setCodeText] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [checked, setChecked] = useState(false);
  const [credMode, setCredMode] = useState<"session" | "mailbox">("session");
  const [session, setSession] = useState("");
  const [email, setEmail] = useState("");
  const [mailboxPassword, setMailboxPassword] = useState("");
  const [preview, setPreview] = useState<SessionPreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const polling = useRef(false);

  const parsed = useMemo(() => takeRedeemCodes(codeText, limit), [codeText, limit]);
  const sessionOk = Boolean(preview?.ok && preview.source === "cardplatform");
  const readyCodes = rows.filter((row) => row.state === "ready").map((row) => row.code);
  const credentialReady =
    credMode === "session"
      ? Boolean(session.trim()) && sessionOk
      : Boolean(email.trim()) && Boolean(mailboxPassword.trim());

  const stats = useMemo(() => {
    const out = { total: rows.length, ok: 0, run: 0, bad: 0, wait: 0, unsure: 0 };
    for (const row of rows) {
      if (row.state === "success") out.ok += 1;
      else if (row.state === "failed" || row.state === "invalid") out.bad += 1;
      else if (row.state === "unknown") out.unsure += 1;
      else if (row.state === "ready" || row.state === "pending") out.wait += 1;
      else out.run += 1;
    }
    return out;
  }, [rows]);

  useEffect(() => {
    if (!orderRef?.orderNo || !orderRef.queryToken) return;
    let stopped = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/public/store-orders/${encodeURIComponent(orderRef.orderNo)}?qt=${encodeURIComponent(orderRef.queryToken)}`,
          { cache: "no-store" },
        );
        const data = await res.json();
        if (stopped) return;
        const codes = (Array.isArray(data.codes) ? data.codes : []) as string[];
        if (!codes.length) {
          setNote("这一单的卡密还没出齐，请回订单页等卡密出来后再来批量兑换。");
          return;
        }
        setCodeText(codes.join("\n"));
        setNote(`已带入订单 ${orderRef.orderNo} 的 ${codes.length} 张卡密。`);
      } catch {
        if (!stopped) setNote("没能自动带入这一单的卡密，请从订单页复制后粘贴到下面。");
      }
    })();
    return () => {
      stopped = true;
    };
  }, [orderRef?.orderNo, orderRef?.queryToken]);

  const refresh = useCallback(async (orderNos: string[]) => {
    if (polling.current || !orderNos.length) return;
    polling.current = true;
    try {
      const res = await fetch("/api/recharge/batch/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderNos }),
      });
      const data = await res.json();
      if (!res.ok) return;
      const byOrder = new Map(
        ((data.list || []) as StatusRow[]).map((item) => [item.orderNo, item]),
      );
      setRows((current) =>
        current.map((row) => {
          const found = row.orderNo ? byOrder.get(row.orderNo) : undefined;
          if (!found) return row;
          return {
            ...row,
            state: batchRowStateFromOrder(found.fulfillStatus),
            message: found.message || row.message,
            accountEmail: found.accountEmail || row.accountEmail,
          };
        }),
      );
    } catch {
      /* 网络抖动就等下一轮，不要把行改成失败 */
    } finally {
      polling.current = false;
    }
  }, []);

  const liveKey = rows
    .filter((row) => row.orderNo && row.state === "running")
    .map((row) => row.orderNo)
    .join(",");

  useEffect(() => {
    if (!liveKey) return;
    const orderNos = liveKey.split(",");
    const timer = setInterval(() => void refresh(orderNos), 3000);
    return () => clearInterval(timer);
  }, [liveKey, refresh]);

  function applyValidated(list: ValidateRow[], previous: Row[]) {
    const byCode = new Map(previous.map((row) => [row.code, row]));
    return list.map<Row>((item) => {
      const before = byCode.get(item.code);
      // 校验不通过但带回了单号，说明这张已经在兑换了：接着轮询就行，绝不重提。
      // 提交时断了网的人就是靠这条路把那几张接回进度里的。
      const state: BatchRowState = item.ok
        ? "ready"
        : item.orderNo
          ? "running"
          : "invalid";
      return {
        code: item.code,
        codeMasked: item.codeMasked || item.code,
        state,
        planName: item.planName || "",
        message: item.ok ? "" : item.error,
        // 校验通过说明这张还没用过，之前那笔失败单的单号是旧的，别再挂着。
        orderNo: item.ok ? "" : item.orderNo,
        accountEmail: before?.accountEmail || "",
      };
    });
  }

  async function validateAll() {
    if (!parsed.codes.length) {
      setError("请填写要兑换的卡密");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/recharge/batch/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codes: parsed.codes }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "校验失败");
      const list = (data.list || []) as ValidateRow[];
      setRows((current) => {
        const committed = new Map(
          current
            .filter((row) => batchRowIsCommitted(row.state))
            .map((row) => [row.code, row]),
        );
        return applyValidated(list, current).map(
          (row) => committed.get(row.code) ?? row,
        );
      });
      setChecked(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "校验失败");
    } finally {
      setBusy(false);
    }
  }

  async function precheckSession() {
    const firstCode = readyCodes[0] || rows[0]?.code || parsed.codes[0] || "";
    if (!session.trim()) {
      setError("请先粘贴 Session");
      return;
    }
    if (!firstCode) {
      setError("请先校验卡密");
      return;
    }
    setChecking(true);
    setError("");
    setPreview(null);
    try {
      const res = await fetch("/api/recharge/session-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: session.trim(), code: firstCode }),
      });
      const data = (await res.json()) as SessionPreview;
      setPreview(data);
      if (data.ok && data.email) setEmail(data.email);
      if (!data.ok && !data.errors?.length) {
        setError(data.error || "Session 预检未通过");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "预检失败");
    } finally {
      setChecking(false);
    }
  }

  function credentialBody() {
    return credMode === "session"
      ? { mode: "session" as const, session: session.trim(), email: email.trim() }
      : {
          mode: "mailbox" as const,
          email: email.trim(),
          password: mailboxPassword.trim(),
        };
  }

  /**
   * 提交这一批。拿不到逐张结果时整批按「结果待确认」处理：订单可能已经建好、
   * 兑换可能已经发给卡台了，重提就是让客户被扣两次。
   */
  async function submitCodes(codes: string[]) {
    if (!codes.length) return;
    const pick = new Set(codes);
    setRows((current) =>
      current.map((row) => (pick.has(row.code) ? { ...row, state: "submitting", message: "" } : row)),
    );
    let status = 0;
    try {
      const res = await fetch("/api/recharge/batch/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codes, ...credentialBody() }),
      });
      status = res.status;
      const data = await res.json();
      const list = (data.list || []) as SubmitRow[];
      if (!res.ok || !list.length) {
        throw new Error(data.error || "提交失败");
      }
      const byCode = new Map(list.map((item) => [item.code, item]));
      setRows((current) =>
        current.map((row) => {
          const found = byCode.get(row.code);
          if (!found) return row;
          return found.ok
            ? {
                ...row,
                state: "running",
                orderNo: found.orderNo,
                message: "已提交，正在开通",
              }
            : { ...row, state: "failed", message: found.error || "提交失败" };
        }),
      );
    } catch (reason) {
      const fallback = batchSubmitFailureState({ status, hadResults: false });
      const message =
        fallback === "unknown"
          ? "没收到提交结果，正在确认，请不要重复提交"
          : reason instanceof Error
            ? reason.message
            : "提交失败";
      setRows((current) =>
        current.map((row) => (pick.has(row.code) ? { ...row, state: fallback, message } : row)),
      );
      if (fallback === "failed") setError(message);
    }
  }

  async function submitBatch() {
    if (!readyCodes.length) {
      setError("没有可兑换的卡密");
      return;
    }
    if (!credentialReady) {
      setError(
        credMode === "session"
          ? "请先点击「预检 Session」，通过卡台校验后再兑换"
          : "请填写账号邮箱和邮箱密码",
      );
      return;
    }
    const account = email.trim() || "这个账号";
    const answer = await ask({
      title: "确认批量兑换",
      message: `这 ${readyCodes.length} 张卡密都会兑换到 ${account}。提交后不能撤销，请确认账号没填错。`,
      confirmLabel: "开始兑换",
    });
    if (!answer) return;
    setBusy(true);
    setError("");
    try {
      await submitCodes(readyCodes);
    } finally {
      setBusy(false);
    }
  }

  async function retryRow(row: Row) {
    if (!canRetryBatchRow(row.state)) return;
    setBusy(true);
    setError("");
    try {
      if (row.state === "invalid") {
        const res = await fetch("/api/recharge/batch/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ codes: [row.code] }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "校验失败");
        const item = ((data.list || []) as ValidateRow[])[0];
        if (!item) throw new Error("校验失败");
        setRows((current) =>
          current.map((entry) =>
            entry.code === row.code ? applyValidated([item], [entry])[0]! : entry,
          ),
        );
        return;
      }
      if (!credentialReady) {
        setError(
          credMode === "session"
            ? "请先预检 Session 再重试"
            : "请填写账号邮箱和邮箱密码",
        );
        return;
      }
      await submitCodes([row.code]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "重试失败");
    } finally {
      setBusy(false);
    }
  }

  async function copyResult() {
    const text = rows
      .map((row) =>
        [
          row.codeMasked,
          publicStatusLabel(row.state, "batch"),
          row.orderNo,
          row.message,
        ]
          .filter(Boolean)
          .join(" · "),
      )
      .join("\n");
    try {
      await copyText(text);
      toast("本批结果已复制");
    } catch {
      toast("复制失败，请手动选择", "err");
    }
  }

  function reset() {
    setRows([]);
    setChecked(false);
    setCodeText("");
    setSession("");
    setMailboxPassword("");
    setEmail("");
    setPreview(null);
    setError("");
    setNote("");
  }

  return (
    <div className="space-y-4">
      {dialog}
      <div className="km-panel km-form-stack">
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium">卡密列表</span>
          <textarea
            className="km-input min-h-28 font-mono text-xs"
            placeholder={`一行一张，也可以用逗号或空格隔开，最多 ${parsed.limit} 张`}
            value={codeText}
            onChange={(event) => setCodeText(event.target.value)}
          />
        </label>
        <p className="text-xs text-[var(--km-fg-muted)]">
          已识别 {parsed.codes.length} 张
          {parsed.dropped > 0 ? `，超出 ${parsed.limit} 张的 ${parsed.dropped} 张没有收下` : ""}
          。重复的卡密会自动合并。
        </p>
        {note ? <p className="text-xs text-[var(--km-fg-muted)]">{note}</p> : null}
        {error && !checked ? (
          <p className="text-sm text-[var(--km-danger)]">{error}</p>
        ) : null}
        <button
          type="button"
          className="km-btn w-full"
          disabled={!parsed.codes.length || busy}
          onClick={() => void validateAll()}
        >
          {busy && !checked ? "校验中…" : `校验这 ${parsed.codes.length} 张`}
        </button>
      </div>

      {checked ? (
        <div className="km-panel km-form-stack">
          <div>
            <p className="font-medium">开通账号</p>
            <p className="mt-1 text-xs text-[var(--km-fg-muted)]">
              这一批全部兑换到同一个账号，凭证只填一次。
            </p>
          </div>
          <div className="km-tabs">
            <button
              type="button"
              className={`km-tab ${credMode === "session" ? "km-tab-active" : ""}`}
              onClick={() => {
                setCredMode("session");
                setError("");
              }}
            >
              Session
            </button>
            <button
              type="button"
              className={`km-tab ${credMode === "mailbox" ? "km-tab-active" : ""}`}
              onClick={() => {
                setCredMode("mailbox");
                setPreview(null);
                setError("");
              }}
            >
              邮箱密码
            </button>
          </div>

          {credMode === "session" ? (
            <>
              <label className="block space-y-1.5 text-sm">
                <span className="font-medium">ChatGPT Session</span>
                <textarea
                  className="km-input min-h-28 font-mono text-xs"
                  placeholder='粘贴整页 JSON，例如 { "user": {...}, "accessToken": "..." }'
                  value={session}
                  onChange={(event) => {
                    setSession(event.target.value);
                    setPreview(null);
                  }}
                />
              </label>
              <ol className="list-decimal space-y-1 pl-4 text-xs leading-relaxed text-[var(--km-fg-muted)]">
                <li>先登录 ChatGPT 账号</li>
                <li>
                  打开{" "}
                  <a
                    href="https://chatgpt.com/api/auth/session"
                    target="_blank"
                    rel="noreferrer"
                    className="text-[var(--km-accent)] underline underline-offset-2"
                  >
                    https://chatgpt.com/api/auth/session
                  </a>
                </li>
                <li>复制整页内容粘贴到此处</li>
              </ol>
              {preview ? (
                <div
                  className={`km-result space-y-1 text-sm ${
                    preview.ok ? "km-session-pass" : "km-session-fail"
                  }`}
                >
                  <p
                    className="font-medium"
                    style={{ color: preview.ok ? "var(--km-success)" : "var(--km-danger)" }}
                  >
                    {preview.ok ? "Session 校验通过" : "Session 校验未通过"}
                  </p>
                  {preview.ok && preview.email ? <p>账号 {preview.email}</p> : null}
                  {preview.errors?.map((msg) => (
                    <p key={msg} className="text-[var(--km-danger)]">
                      {msg}
                    </p>
                  ))}
                  {preview.warnings?.map((msg) => (
                    <p key={msg} className="text-[var(--km-fg-muted)]">
                      {msg}
                    </p>
                  ))}
                </div>
              ) : null}
              <button
                type="button"
                className="km-btn km-btn-ghost w-full"
                disabled={!session.trim() || checking || busy}
                onClick={() => void precheckSession()}
              >
                {checking ? "校验中…" : sessionOk ? "重新预检" : "预检 Session"}
              </button>
            </>
          ) : (
            <>
              <label className="block space-y-1.5 text-sm">
                <span className="font-medium">账号邮箱</span>
                <input
                  className="km-input"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label className="block space-y-1.5 text-sm">
                <span className="font-medium">邮箱密码</span>
                <input
                  className="km-input"
                  type="password"
                  placeholder="该邮箱对应的登录密码"
                  value={mailboxPassword}
                  onChange={(event) => setMailboxPassword(event.target.value)}
                />
              </label>
            </>
          )}

          {error ? <p className="text-sm text-[var(--km-danger)]">{error}</p> : null}

          <button
            className="km-btn km-btn-primary w-full"
            disabled={busy || checking || !readyCodes.length || !credentialReady}
            onClick={() => void submitBatch()}
          >
            {busy ? "提交中…" : `提交兑换（${readyCodes.length} 张）`}
          </button>
        </div>
      ) : null}

      {rows.length ? (
        <div className="km-panel space-y-4">
          <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-5">
            {(
              [
                ["共", stats.total],
                ["待兑换", stats.wait],
                ["处理中", stats.run],
                ["已成功", stats.ok],
                ["失败", stats.bad],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="km-stat">
                <p className="text-lg font-semibold">{value}</p>
                <p className="text-xs text-[var(--km-fg-muted)]">{label}</p>
              </div>
            ))}
          </div>
          {stats.unsure > 0 ? (
            <p className="text-sm text-[var(--km-fg-muted)]">
              有 {stats.unsure} 张结果待确认，我们正在和卡台核对，请不要重复提交。核对完会显示在下面。
            </p>
          ) : null}

          <ul className="divide-y divide-[var(--km-border)]">
            {rows.map((row, index) => (
              <li key={row.code} className="space-y-1 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-6 text-xs text-[var(--km-fg-muted)]">{index + 1}</span>
                  <span className="font-mono">{row.codeMasked}</span>
                  {row.planName ? (
                    <span className="text-xs text-[var(--km-fg-muted)]">{row.planName}</span>
                  ) : null}
                  <span className={`ml-auto ${badgeClass(row.state)}`}>
                    {publicStatusLabel(row.state, "batch")}
                  </span>
                </div>
                <div className="space-y-1 pl-8 text-xs text-[var(--km-fg-muted)]">
                  {row.accountEmail ? <p>账号 {row.accountEmail}</p> : null}
                  {row.message ? <p>{row.message}</p> : null}
                  {row.state === "unknown" ? (
                    <p className="text-[var(--km-fg)]">正在确认，请不要重复提交。</p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-3">
                    {row.orderNo ? (
                      <Link
                        className="underline"
                        href={`/lookup?orderNo=${encodeURIComponent(row.orderNo)}`}
                      >
                        查看这张的进度
                      </Link>
                    ) : null}
                    {canRetryBatchRow(row.state) ? (
                      <button
                        type="button"
                        className="km-btn km-btn-ghost"
                        disabled={busy}
                        onClick={() => void retryRow(row)}
                      >
                        {row.state === "invalid" ? "重新校验" : "重试这一张"}
                      </button>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>

          <div className="grid gap-2 sm:grid-cols-2">
            <button type="button" className="km-btn km-btn-ghost" onClick={() => void copyResult()}>
              复制本批结果
            </button>
            <button type="button" className="km-btn km-btn-ghost" disabled={busy} onClick={reset}>
              换一批卡密
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
