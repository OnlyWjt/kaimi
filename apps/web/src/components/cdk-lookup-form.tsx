"use client";

import { useState } from "react";

type LookupResult = {
  found: boolean;
  codeMasked?: string;
  status?: string;
  planName?: string;
  orderNo?: string | null;
  fulfillStatus?: string | null;
  message?: string;
};

export function CdkLookupForm() {
  const [code, setCode] = useState("");
  const [result, setResult] = useState<LookupResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function query() {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch(`/api/cdk/lookup?code=${encodeURIComponent(code.trim())}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "查询失败");
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "查询失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="km-shell-narrow space-y-6 pb-4">
      <div className="km-page-hero km-rise">
        <p className="km-eyebrow">卡密状态</p>
        <h1 className="km-page-title">卡密查询</h1>
        <p className="km-lead">输入卡密，查看使用状态。</p>
      </div>
      <div className="km-panel km-form-stack km-rise">
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium">卡密</span>
          <input
            className="km-input font-mono"
            placeholder="购买后拿到的那串卡密"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void query();
            }}
          />
        </label>
        <div className="km-form-actions">
          <button className="km-btn" disabled={!code.trim() || busy} onClick={() => void query()}>
            {busy ? "查询中…" : "查询"}
          </button>
        </div>
        {error ? <p className="text-sm text-[var(--km-danger)]">{error}</p> : null}
        {result ? (
          <div className="km-result">
            {!result.found ? (
              <p>没有查到这张卡密。请检查有没有输错，或者确认是不是在本站购买的。</p>
            ) : (
              <ul className="space-y-1.5">
                <li>卡密：{result.codeMasked}</li>
                <li>状态：{result.status}</li>
                {result.planName ? <li>套餐：{result.planName}</li> : null}
                {result.orderNo ? <li>关联订单：{result.orderNo}</li> : null}
                {result.fulfillStatus ? <li>订单状态：{result.fulfillStatus}</li> : null}
                {result.message ? <li>{result.message}</li> : null}
              </ul>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
