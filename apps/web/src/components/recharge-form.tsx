"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  OrderProgressPanel,
  type OrderProgressRow,
  type ProgressEvent,
} from "@/components/order-progress-panel";
import { isOrderTerminalStatus, normalizeOrderStatus } from "@/lib/order-status";
import Link from "next/link";
import { RegionBadge } from "@/components/region-badge";
import {
  CredentialSwitch,
  MIN_CODE_LENGTH,
  RedeemSteps,
  SessionGuide,
  redeemApiError,
} from "@/components/redeem-ui";
import { useShopToolPaths } from "@/components/use-shop-tool-paths";

type Validated = {
  codeMasked: string;
  planKey: string;
  planName: string;
  paymentCountry?: string;
  regionLabel?: string;
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
  const paths = useShopToolPaths();

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
    if (trimmed.length < MIN_CODE_LENGTH) {
      setError("卡密不完整，请粘贴完整的一串");
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
      if (!res.ok || !data.ok) throw new Error(redeemApiError(data, "校验失败"));
      setValidated({
        codeMasked: data.codeMasked,
        planKey: data.planKey,
        planName: data.planName,
        paymentCountry: data.paymentCountry || "",
        regionLabel: data.regionLabel || "",
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
        setError(redeemApiError(data, "Session 预检未通过"));
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
      // 预检已经在点提交前做过。这里不再打 session-check，否则按钮还要再等一轮卡台。
      const accountEmail = (
        credMode === "session" ? preview?.email || email : email
      ).trim();

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
          planKey: validated.planKey || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(redeemApiError(data, "提交失败"));

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

  const stepIndex = progress ? 2 : step === "session" ? 1 : 0;
  const progressStatus = normalizeOrderStatus(String(progress?.fulfillStatus || ""));
  const finished = progressStatus === "success";
  const showRegion = Boolean(validated && (validated.regionLabel || validated.planName.includes("·")));
  // 校验时拿到的是「未使用」，提交以后要跟着进度变，不然开通成功了这里还写着未使用。
  const statusLabel = progress
    ? finished
      ? "已兑换"
      : progressStatus === "failed"
        ? "未兑换"
        : "兑换中"
    : validated?.status === "unused" || validated?.status === "未使用"
      ? "未使用"
      : validated?.status || "";
  const statusTone = !progress || finished ? "km-badge-ok" : progressStatus === "failed" ? "km-badge-bad" : "km-badge-wait";

  return (
    <div className="km-rx-flow">
      <RedeemSteps current={stepIndex} done={finished} />
      {step === "code" ? (
        <section className="km-rx-card">
          <div className="km-rx-card-head">
            <h2 className="km-rx-card-title">粘贴卡密</h2>
            <p className="km-rx-card-desc">购买后订单页或邮件里的那一串，校验后自动识别套餐</p>
          </div>
          <div className="km-rx-code-row">
            <input
              className="km-input km-rx-code-input"
              placeholder="例如 ZC-XXXXXXXX-XXXX"
              value={code}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setCode(e.target.value);
                if (error) setError("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void validateCode();
              }}
              aria-label="卡密"
              aria-invalid={Boolean(error)}
            />
            <button type="button" className="km-btn km-rx-code-go" disabled={busy} onClick={() => void validateCode()}>
              {busy ? "校验中…" : "校验"}
            </button>
          </div>
          {error ? (
            <p className="km-rx-error" role="alert">
              {error}
            </p>
          ) : null}
          <p className="km-rx-card-foot">
            已经提交过？<Link href={paths.lookup}>查看订单进度</Link>
          </p>
        </section>
      ) : (
        <>
          <section className="km-rx-card km-rx-plan">
            <div className="km-rx-plan-main">
              <p className="km-rx-eyebrow">已识别套餐</p>
              <h2 className="km-rx-plan-name">{validated?.planName}</h2>
              <dl className="km-rx-meta">
                <div>
                  <dt>卡密</dt>
                  <dd className="font-mono">{validated?.codeMasked}</dd>
                </div>
                {showRegion && validated ? (
                  <div>
                    <dt>付款地区</dt>
                    <dd>
                      <RegionBadge country={validated.paymentCountry || ""} regionLabel={validated.regionLabel} />
                    </dd>
                  </div>
                ) : null}
              </dl>
              {showRegion && validated?.paymentCountry ? (
                <p className="km-rx-plan-note">这张卡密按该地区结账，与你账号所在地无关。</p>
              ) : null}
            </div>
            <div className="km-rx-plan-side">
              {statusLabel ? <span className={`km-badge ${statusTone}`}>{statusLabel}</span> : null}
              {!progress ? (
                <button type="button" className="km-rx-link" onClick={resetCode}>
                  更换卡密
                </button>
              ) : null}
            </div>
          </section>

          {progress ? (
            <OrderProgressPanel
              row={progress}
              polling={autoPoll}
              events={events}
              showLookupLink
              onRetry={() => {
                setProgress(null);
                setEvents([]);
                setAutoPoll(false);
                setError("");
              }}
            />
          )   : (
            <section className="km-rx-card km-form-stack">
              <div className="km-rx-card-head km-rx-card-head-row">
                <div>
                  <h2 className="km-rx-card-title">开通账号</h2>
                  <p className="km-rx-card-desc">
                    {credMode === "session" ? "粘贴 ChatGPT Session，先预检账号再提交" : "填写要开通的账号邮箱和登录密码"}
                  </p>
                </div>
                <CredentialSwitch
                  value={credMode}
                  onChange={(mode) => {
                    setCredMode(mode);
                    if (mode === "mailbox") setPreview(null);
                    setError("");
                  }}
                />
              </div>

              {credMode === "session" ? (
                <>
                  <label className="km-rx-field">
                    <span className="km-rx-field-label">ChatGPT Session</span>
                    <textarea
                      className="km-input km-rx-session"
                      placeholder='整页 JSON，形如 { "user": {…}, "accessToken": "…" }'
                      value={session}
                      spellCheck={false}
                      onChange={(e) => {
                        setSession(e.target.value);
                        setPreview(null);
                      }}
                    />
                  </label>
                  <SessionGuide />
                </>
              ) : null}

              {credMode === "mailbox" ? (
                <div className="km-rx-fields">
                  <label className="km-rx-field">
                    <span className="km-rx-field-label">账号邮箱</span>
                    <input
                      className="km-input"
                      type="email"
                      autoComplete="off"
                      placeholder="you@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </label>
                  <label className="km-rx-field">
                    <span className="km-rx-field-label">登录密码</span>
                    <input
                      className="km-input"
                      type="password"
                      autoComplete="new-password"
                      placeholder="这个邮箱登录 ChatGPT 的密码"
                      value={mailboxPassword}
                      onChange={(e) => setMailboxPassword(e.target.value)}
                    />
                  </label>
                </div>
              ) : null}

              {preview && credMode === "session" ? (
                <div className={`km-rx-check km-submit-reveal ${preview.ok ? "km-rx-check-pass" : "km-rx-check-fail"}`}>
                  <p className="km-rx-check-title">{preview.ok ? "Session 预检通过" : "Session 预检未通过"}</p>
                  {preview.ok ? (
                    <dl className="km-rx-meta">
                      {preview.email ? (
                        <div>
                          <dt>账号</dt>
                          <dd>{preview.email}</dd>
                        </div>
                      ) : null}
                      {preview.name ? (
                        <div>
                          <dt>显示名</dt>
                          <dd>{preview.name}</dd>
                        </div>
                      ) : null}
                      {preview.summary?.plan_type || preview.planHint ? (
                        <div>
                          <dt>当前订阅</dt>
                          <dd>{String(preview.summary?.plan_type || preview.planHint)}</dd>
                        </div>
                      ) : null}
                      {typeof preview.summary?.has_active_subscription === "boolean" ? (
                        <div>
                          <dt>有效订阅</dt>
                          <dd>{preview.summary.has_active_subscription ? "是" : "否"}</dd>
                        </div>
                      ) : null}
                      {preview.summary?.expires_at ? (
                        <div>
                          <dt>到期</dt>
                          <dd>{String(preview.summary.expires_at)}</dd>
                        </div>
                      ) : null}
                    </dl>
                  ) : null}
                  {preview.errors?.map((msg) => (
                    <p key={msg} className="km-rx-check-error">
                      {msg}
                    </p>
                  ))}
                  {preview.warnings?.map((msg) => (
                    <p key={msg} className="km-rx-check-warn">
                      {msg}
                    </p>
                  ))}
                </div>
              ) : null}

              {error ? (
                <p className="km-rx-error" role="alert">
                  {error}
                </p>
              ) : null}

              {credMode === "session" ? (
                sessionOk ? (
                  <div className="km-rx-actions km-submit-reveal">
                    <button className="km-btn km-rx-primary" disabled={busy || checking} onClick={() => void submit()}>
                      {busy ? "提交中…" : "提交兑换"}
                    </button>
                    <button
                      type="button"
                      className="km-rx-link"
                      disabled={busy || checking || !session.trim()}
                      onClick={() => void precheckSession()}
                    >
                      {checking ? "预检中…" : "改了 Session？重新预检"}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="km-btn km-rx-primary"
                    disabled={!session.trim() || busy || checking}
                    onClick={() => void precheckSession()}
                  >
                    {checking ? "预检中…" : session.trim() ? "预检 Session" : "先粘贴 Session"}
                  </button>
                )
              ) : null}

              {credMode === "mailbox" ? (
                <button
                  className="km-btn km-rx-primary"
                  disabled={!email.trim() || !mailboxPassword.trim() || busy}
                  onClick={() => void submit()}
                >
                  {busy ? "提交中…" : "提交兑换"}
                </button>
              ) : null}

            </section>
          )}
        </>
      )}
    </div>
  );
}
