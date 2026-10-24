"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  OrderProgressPanel,
  type OrderProgressRow,
  type ProgressEvent,
} from "@/components/order-progress-panel";
import { RegionBadge } from "@/components/region-badge";
import {
  RedeemSteps,
  SessionCheckResult,
  SessionField,
  credentialName,
  readRedeemJson,
  redeemApiError,
  type SessionPreview,
} from "@/components/redeem-ui";
import { useShopToolPaths } from "@/components/use-shop-tool-paths";
import { isOrderTerminalStatus, normalizeOrderStatus } from "@/lib/order-status";
import { REDEEM_CODE_MIN_LENGTH } from "@/lib/redeem-code";
import { isCardProduct, type CardProduct } from "@/lib/cardplatform/product";
import { publicStatusLabel } from "@/lib/status-labels";

type Validated = {
  codeMasked: string;
  /** 卡密的产品线，决定要粘贴哪种登录凭证。 */
  product: CardProduct;
  planKey: string;
  planName: string;
  paymentCountry?: string;
  regionLabel?: string;
  productId: number | null;
  price?: string;
  status: string;
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
  const [session, setSession] = useState("");
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
  const product: CardProduct = validated?.product ?? "gpt";
  const credName = credentialName(product);

  useEffect(() => {
    if (initialCode.trim()) setCode(initialCode.trim());
  }, [initialCode]);

  const refreshProgress = useCallback(async (orderNo: string, quiet = false) => {
    if (!orderNo.trim()) return;
    try {
      const res = await fetch(`/api/shop/query?orderNo=${encodeURIComponent(orderNo.trim())}`);
      const data = await readRedeemJson(res);
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
    if (trimmed.length < REDEEM_CODE_MIN_LENGTH) {
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
      const data = await readRedeemJson(res);
      if (!res.ok || !data.ok) throw new Error(redeemApiError(data, "校验失败"));
      setValidated({
        codeMasked: data.codeMasked,
        product: isCardProduct(data.product) ? data.product : "gpt",
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
      setError(`请先粘贴 ${credName}`);
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
          product,
        }),
      });
      const data = (await readRedeemJson(res)) as SessionPreview;
      setPreview(data);
      if (data.ok && data.email) {
        setEmail(data.email);
      }
      if (!data.ok && !data.errors?.length) {
        setError(redeemApiError(data, `${credName} 预检未通过`));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "预检失败");
    } finally {
      setChecking(false);
    }
  }

  async function submit() {
    if (!validated) return;
    if (!session.trim()) {
      setError(`请填写 ${credName}`);
      return;
    }
    if (!sessionOk) {
      setError(`请先点击「预检 ${credName}」，通过卡台校验后再兑换`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      // 预检已经在点提交前做过。这里不再打 session-check，否则按钮还要再等一轮卡台。
      const accountEmail = (preview?.email || email).trim();

      const res = await fetch("/api/recharge/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: code.trim(),
          email: accountEmail,
          mode: "session",
          session: session.trim(),
          productId: validated.productId ?? undefined,
          planKey: validated.planKey || undefined,
          product: validated.product,
        }),
      });
      const data = await readRedeemJson(res);
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
    setEmail("");
    setError("");
    setProgress(null);
    setEvents([]);
    setAutoPoll(false);
    setPreview(null);
  }

  /** 成功后接着兑下一张：Session 多半还是同一个账号，留着，但预检绑的是上一张卡，要重做。 */
  function redeemAnother() {
    const keptSession = session;
    resetCode();
    setCode("");
    setSession(keptSession);
  }

  const stepIndex = progress ? 2 : step === "session" ? 1 : 0;
  const progressStatus = normalizeOrderStatus(String(progress?.fulfillStatus || ""));
  const finished = progressStatus === "success";
  const failed = progressStatus === "failed";
  const showRegion = Boolean(validated && (validated.regionLabel || validated.planName.includes("·")));
  // 校验时拿到的是「未使用」，提交以后要跟着进度变，不然开通成功了这里还写着未使用。
  // 失败时卡会退回，所以是「未使用」。
  const cardStatus = progress ? (finished ? "used" : failed ? "unused" : "redeeming") : "unused";
  // 失败时卡已退回，「未使用」是好消息，别标红。
  const statusTone = finished || !progress ? "km-badge-ok" : failed ? "km-badge-muted" : "km-badge-wait";

  return (
    <div className="km-rx-flow">
      <RedeemSteps current={stepIndex} outcome={finished ? "success" : failed ? "failed" : undefined} />
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
              <span className={`km-badge ${statusTone}`}>{publicStatusLabel(cardStatus, "cdk")}</span>
              {!progress ? (
                <button type="button" className="km-rx-link" onClick={resetCode}>
                  更换卡密
                </button>
              ) : null}
            </div>
          </section>

          {progress ? (
            <>
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
              {finished ? (
                <button type="button" className="km-btn km-btn-ghost km-rx-primary" onClick={redeemAnother}>
                  再兑换一张
                </button>
              ) : null}
            </>
          ) : (
            <section className="km-rx-card km-form-stack">
              <div className="km-rx-card-head">
                <h2 className="km-rx-card-title">开通账号</h2>
                <p className="km-rx-card-desc">
                  粘贴 {product === "gpt" ? "ChatGPT Session" : credName}，先预检账号再提交
                </p>
              </div>

              <SessionField
                product={product}
                value={session}
                onChange={(value) => {
                  setSession(value);
                  setPreview(null);
                }}
              />

              {preview ? <SessionCheckResult preview={preview} product={product} /> : null}

              {error ? (
                <p className="km-rx-error" role="alert">
                  {error}
                </p>
              ) : null}

              {sessionOk ? (
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
                    {checking ? "预检中…" : `改了 ${credName}？重新预检`}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="km-btn km-rx-primary"
                  disabled={!session.trim() || busy || checking}
                  onClick={() => void precheckSession()}
                >
                  {checking ? "预检中…" : session.trim() ? `预检 ${credName}` : `先粘贴 ${credName}`}
                </button>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
