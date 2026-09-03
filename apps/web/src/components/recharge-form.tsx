"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  OrderProgressPanel,
  type OrderProgressRow,
  type ProgressEvent,
} from "@/components/order-progress-panel";
import { isOrderTerminalStatus, normalizeOrderStatus } from "@/lib/order-status";

type Validated = {
  codeMasked: string;
  planKey: string;
  planName: string;
  productId: number | null;
  price?: string;
  status: string;
};

type SessionSummary = {
  email?: string;
  plan_type?: string;
  has_active_subscription?: boolean;
  expires_at?: string;
  account_id?: string;
};

type SessionPreview = {
  ok: boolean;
  email?: string;
  name?: string;
  hasAccessToken?: boolean;
  planHint?: string;
  summary?: SessionSummary;
  errors?: string[];
  warnings?: string[];
  source?: string;
  error?: string;
  error_code?: string;
};

function appendProgressEvent(
  prev: ProgressEvent[],
  status: string,
  message: string,
): ProgressEvent[] {
  const st = normalizeOrderStatus(status);
  if (!st) return prev;
  const last = prev[prev.length - 1];
  if (last && last.status === st && last.message === message) return prev;
  return [...prev, { status: st, message, at: new Date().toISOString() }];
}

export function RechargeForm({ initialCode = "" }: { initialCode?: string }) {
  const [step, setStep] = useState<"code" | "session">("code");
  const [code, setCode] = useState(initialCode);
  const [validated, setValidated] = useState<Validated | null>(null);
  const [email, setEmail] = useState("");
  const [credMode, setCredMode] = useState<"session" | "mailbox">("session");
  const [session, setSession] = useState("");
  const [mailboxPassword, setMailboxPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<SessionPreview | null>(null);
  const [progress, setProgress] = useState<OrderProgressRow | null>(null);
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [autoPoll, setAutoPoll] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const sessionOk = Boolean(preview?.ok && preview.source === "cardplatform");

  useEffect(() => {
    if (initialCode.trim()) setCode(initialCode.trim());
  }, [initialCode]);

  const refreshProgress = useCallback(async (orderNo: string, quiet = false) => {
    if (!orderNo.trim()) return;
    try {
      const res = await fetch(`/api/shop/query?orderNo=${encodeURIComponent(orderNo.trim())}`);
      const data = await res.json();
      const row = ((data.list || []) as OrderProgressRow[])[0];
      if (row) {
        setProgress(row);
        const st = normalizeOrderStatus(String(row.fulfillStatus || ""));
        const msg = row.message != null ? String(row.message) : "";
        const history = (row as { history?: ProgressEvent[] }).history;
        if (Array.isArray(history) && history.length) {
          setEvents(
            history.map((h) => ({
              status: normalizeOrderStatus(String(h.status || "")) || String(h.status || ""),
              message: String(h.message || ""),
              at: String(h.at || new Date().toISOString()),
            })),
          );
        } else {
          setEvents((prev) => appendProgressEvent(prev, st, msg));
        }
        setAutoPoll(st !== "" && !isOrderTerminalStatus(st));
      } else if (!quiet) {
        setAutoPoll(false);
      }
    } catch {
      /* keep last */
    }
  }, []);

  useEffect(() => {
    const orderNo = String(progress?.orderNo || "");
    if (!autoPoll || !orderNo) {
      if (timer.current) {
        clearInterval(timer.current);
        timer.current = null;
      }
      return;
    }
    timer.current = setInterval(() => {
      void refreshProgress(orderNo, true);
    }, 2000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [autoPoll, progress?.orderNo, refreshProgress]);

  async function validateCode() {
    const trimmed = code.trim();
    if (!trimmed) {
      setError("请填写卡密");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/recharge/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: trimmed }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "校验失败");
      setValidated({
        codeMasked: data.codeMasked,
        planKey: data.planKey,
        planName: data.planName,
        productId: data.productId ?? null,
        price: data.price,
        status: data.status,
      });
      setStep("session");
    } catch (e) {
      setError(e instanceof Error ? e.message : "校验失败");
      setValidated(null);
    } finally {
      setBusy(false);
    }
  }

  async function precheckSession() {
    if (!session.trim()) {
      setError("请先粘贴 Session");
      setPreview(null);
      return;
    }
    setChecking(true);
    setError("");
    setPreview(null);
    try {
      const res = await fetch("/api/recharge/session-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session: session.trim(),
          code: code.trim(),
          planKey: validated?.planKey,
        }),
      });
      const data = (await res.json()) as SessionPreview;
      setPreview(data);
      if (data.ok && data.email) {
        setEmail(data.email);
      }
      if (!data.ok && !data.errors?.length) {
        setError(data.error || "Session 预检未通过");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "预检失败");
    } finally {
      setChecking(false);
    }
  }

  async function submit() {
    if (!validated) return;
    if (credMode === "mailbox") {
      if (!email.trim()) {
        setError("请填写账号邮箱");
        return;
      }
      if (!mailboxPassword.trim()) {
        setError("请填写邮箱密码");
        return;
      }
    } else {
      if (!session.trim()) {
        setError("请填写 Session");
        return;
      }
      if (!sessionOk) {
        setError("请先点击「预检 Session」，通过卡台校验后再兑换");
        return;
      }
    }
    setBusy(true);
    setError("");
    try {
      let accountEmail = email.trim();
      if (credMode === "session") {
        const checkRes = await fetch("/api/recharge/session-check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session: session.trim(),
            code: code.trim(),
            planKey: validated.planKey,
          }),
        });
        const checkData = (await checkRes.json()) as SessionPreview;
        setPreview(checkData);
        if (!checkData.ok || checkData.source !== "cardplatform") {
          throw new Error(checkData.errors?.[0] || "Session 预检未通过，请修正后再提交");
        }
        accountEmail = (checkData.email || preview?.email || email).trim();
      }

      const res = await fetch("/api/recharge/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: code.trim(),
          email: accountEmail,
          mode: credMode,
          session: credMode === "session" ? session.trim() : undefined,
          password: credMode === "mailbox" ? mailboxPassword.trim() : undefined,
          productId: validated.productId ?? undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "提交失败");

      const orderNo = String(data.orderNo || "");
      const st = normalizeOrderStatus(String(data.fulfillStatus || "pending"));
      const msg = String(data.message || "已提交");
      setProgress({ orderNo, fulfillStatus: st, message: msg });
      setEvents([{ status: st || "pending", message: msg, at: new Date().toISOString() }]);
      setAutoPoll(Boolean(orderNo) && st !== "" && !isOrderTerminalStatus(st));
      if (orderNo) void refreshProgress(orderNo, true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "提交失败";
      setError(msg);
      if (/禁用|收回|不可用|同步库存/.test(msg)) {
        setValidated(null);
        setStep("code");
        setPreview(null);
        setProgress(null);
        setEvents([]);
        setAutoPoll(false);
      }
    } finally {
      setBusy(false);
    }
  }

  function resetCode() {
    setStep("code");
    setValidated(null);
    setSession("");
    setMailboxPassword("");
    setEmail("");
    setError("");
    setProgress(null);
    setEvents([]);
    setAutoPoll(false);
    setPreview(null);
  }

  return (
    <div className="mx-auto w-full space-y-6">
      {step === "code" ? (
        <div className="km-panel km-form-stack">
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">卡密</span>
            <input
              className="km-input font-mono"
              placeholder="CDK-XXXX-XXXX-XXXX"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void validateCode();
              }}
            />
          </label>
          {error ? <p className="text-sm text-[var(--km-danger)]">{error}</p> : null}
          <button className="km-btn w-full" disabled={!code.trim() || busy} onClick={() => void validateCode()}>
            {busy ? "校验中…" : "校验卡密"}
          </button>
          <p className="text-xs text-[var(--km-fg-muted)]">校验通过后会自动识别套餐。</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="km-panel space-y-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-[var(--km-fg-muted)]">已识别套餐</p>
              <h2 className="mt-1 text-xl font-semibold" style={{ fontFamily: "var(--font-sora)" }}>
                {validated?.planName}
              </h2>
              <p className="mt-1 font-mono text-sm text-[var(--km-fg-muted)]">{validated?.planKey}</p>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-[var(--km-border)] pt-3 text-sm text-[var(--km-fg-muted)]">
              <span>卡密 {validated?.codeMasked}</span>
              <span>状态 {validated?.status}</span>
            </div>
            {!progress ? (
              <button type="button" className="text-sm text-[var(--km-accent)] hover:underline" onClick={resetCode}>
                更换卡密
              </button>
            ) : null}
          </div>

          <div className="km-panel km-form-stack">
            {!progress ? (
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
            ) : null}

            {credMode === "session" ? (
              <>
                <label className="block space-y-1.5 text-sm">
                  <span className="font-medium">ChatGPT Session</span>
                  <textarea
                    className="km-input min-h-28 font-mono text-xs"
                    placeholder='粘贴整页 JSON，例如 { "user": {...}, "accessToken": "..." }'
                    value={session}
                    disabled={Boolean(progress)}
                    onChange={(e) => {
                      setSession(e.target.value);
                      setPreview(null);
                    }}
                  />
                </label>
                {!progress ? (
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
                ) : null}
              </>
            ) : (
              <>
                <label className="block space-y-1.5 text-sm">
                  <span className="font-medium">账号邮箱</span>
                  <input
                    className="km-input"
                    placeholder="you@example.com"
                    value={email}
                    disabled={Boolean(progress)}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </label>
                <label className="block space-y-1.5 text-sm">
                  <span className="font-medium">邮箱密码</span>
                  <input
                    className="km-input"
                    type="password"
                    placeholder="该邮箱对应的登录密码"
                    value={mailboxPassword}
                    disabled={Boolean(progress)}
                    onChange={(e) => setMailboxPassword(e.target.value)}
                  />
                </label>
              </>
            )}

            {preview && !progress && credMode === "session" ? (
              <div
                className={`km-result km-submit-reveal space-y-2 text-sm ${
                  preview.ok ? "km-session-pass" : "km-session-fail"
                }`}
              >
                <p className="font-medium" style={{ color: preview.ok ? "var(--km-success)" : "var(--km-danger)" }}>
                  {preview.ok ? "Session 校验通过" : "Session 校验未通过"}
                </p>
                {preview.ok ? (
                  <div className="grid gap-1 text-[var(--km-fg)]">
                    {preview.email ? <p>账号 {preview.email}</p> : null}
                    {preview.name ? <p>显示名 {preview.name}</p> : null}
                    {preview.summary?.plan_type || preview.planHint ? (
                      <p>当前订阅 {String(preview.summary?.plan_type || preview.planHint)}</p>
                    ) : null}
                    {typeof preview.summary?.has_active_subscription === "boolean" ? (
                      <p>有效订阅 {preview.summary.has_active_subscription ? "是" : "否"}</p>
                    ) : null}
                    {preview.summary?.expires_at ? <p>到期 {String(preview.summary.expires_at)}</p> : null}
                  </div>
                ) : null}
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

            {error ? <p className="text-sm text-[var(--km-danger)]">{error}</p> : null}

            {!progress && credMode === "session" ? (
              <div className="space-y-3">
                {!sessionOk ? (
                  <button
                    type="button"
                    className="km-btn w-full"
                    disabled={!session.trim() || busy || checking}
                    onClick={() => void precheckSession()}
                  >
                    {checking ? "校验中…" : "预检 Session"}
                  </button>
                ) : (
                  <div className="km-submit-reveal space-y-2">
                    <button className="km-btn w-full" disabled={busy || checking} onClick={() => void submit()}>
                      {busy ? "提交中…" : "提交兑换"}
                    </button>
                    <button
                      type="button"
                      className="km-btn km-btn-ghost w-full"
                      disabled={busy || checking || !session.trim()}
                      onClick={() => void precheckSession()}
                    >
                      {checking ? "校验中…" : "重新预检"}
                    </button>
                  </div>
                )}
              </div>
            ) : null}

            {!progress && credMode === "mailbox" ? (
              <button
                className="km-btn w-full"
                disabled={!email.trim() || !mailboxPassword.trim() || busy}
                onClick={() => void submit()}
              >
                {busy ? "提交中…" : "提交兑换"}
              </button>
            ) : null}

            {progress ? (
              <OrderProgressPanel row={progress} polling={autoPoll} events={events} showLookupLink />
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
