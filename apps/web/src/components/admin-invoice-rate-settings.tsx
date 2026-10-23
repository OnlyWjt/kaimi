"use client";

import { useEffect, useState } from "react";
import { splitInvoiceSurcharge } from "@/lib/invoice-core";

const SAMPLE_GOODS_CENTS = 10000;
const SAMPLE_RATE_PCT = 17;

function yuan(cents: number) {
  return `¥${(cents / 100).toFixed(2)}`;
}

/** 「通知」页里的代理开票分成扣税比例。哪些代理能自定义税点在「代理」页逐个开通。 */
export function AdminInvoiceRateSettings() {
  const [saved, setSaved] = useState<number | null>(null);
  const [percent, setPercent] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/admin/invoice-rate", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (typeof data?.agentTaxBp !== "number") return;
        setSaved(data.agentTaxBp);
        setPercent(String(data.agentTaxBp / 100));
      })
      .catch(() => undefined);
  }, []);

  if (saved === null) return null;
  const text = percent.trim();
  const bp = /^\d+(\.\d{1,2})?$/.test(text) ? Math.round(Number(text) * 100) : null;
  const valid = bp !== null && bp <= 2000;
  const dirty = valid && bp !== saved;
  // 输入不合法时票面按已保存的比例算
  const split = splitInvoiceSurcharge(SAMPLE_GOODS_CENTS, {
    split: true,
    ratePct: SAMPLE_RATE_PCT,
    agentTaxBp: valid ? bp : saved,
  });

  async function save() {
    if (!valid) {
      setMessage("请填 0–20 之间的数，最多两位小数");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/invoice-rate", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentTaxBp: bp }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存失败");
      setSaved(data.agentTaxBp);
      setPercent(String(data.agentTaxBp / 100));
      setMessage("已保存，只影响之后下的单");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="km-panel space-y-4">
      <div>
        <h2 className="text-xl font-semibold">代理开票分成</h2>
        <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
          在「代理管理」里逐个开通。开通的代理可把税点设在 6%–17%：平台固定收 6%，多出来的扣税后归代理，整单手续费由代理承担。没开通的照旧 10%，全归平台。
        </p>
      </div>
      <div className="km-rate-layout">
        <div className="space-y-2">
          <span className="block text-sm">代理分成扣税比例</span>
          <div className="km-rate-field">
            <label className="km-rate-input">
              <input
                className="km-input"
                inputMode="decimal"
                aria-label="代理分成扣税比例"
                aria-invalid={!valid}
                value={percent}
                onChange={(event) => {
                  setPercent(event.target.value);
                  setMessage("");
                }}
              />
              <span>%</span>
            </label>
            <button
              type="button"
              className={`km-btn${dirty ? "" : " km-btn-ghost"}`}
              disabled={busy || !dirty}
              onClick={() => void save()}
            >
              {busy ? "保存中…" : valid && !dirty ? "已保存" : "保存"}
            </button>
          </div>
          <p className={`text-xs ${valid ? "text-[var(--km-fg-muted)]" : "text-[var(--km-danger)]"}`}>
            {message ||
              (valid
                ? "0–20，可带两位小数。小规模纳税人一般填 1。改了只影响之后下的单。"
                : "请填 0–20 之间的数，最多两位小数")}
          </p>
        </div>
        <div className="km-rate-receipt">
          <p>
            例：商品 {yuan(SAMPLE_GOODS_CENTS)}，代理设 {SAMPLE_RATE_PCT}%，买家付{" "}
            {yuan(SAMPLE_GOODS_CENTS + split.surchargeCents)}
          </p>
          <dl>
            <div>
              <dt>开票加价 {SAMPLE_RATE_PCT}%</dt>
              <dd>{yuan(split.surchargeCents)}</dd>
            </div>
            <div>
              <dt>平台收 6%</dt>
              <dd>−{yuan(split.platformCents)}</dd>
            </div>
            <div>
              <dt>扣税（留在平台）</dt>
              <dd>−{yuan(split.agentTaxCents)}</dd>
            </div>
            <div className="is-total">
              <dt>代理多拿</dt>
              <dd>{yuan(split.agentNetCents)}</dd>
            </div>
          </dl>
          <p style={{ margin: "0.6rem 0 0" }}>平台这单实得 {yuan(split.platformCents + split.agentTaxCents)}</p>
        </div>
      </div>
    </section>
  );
}
