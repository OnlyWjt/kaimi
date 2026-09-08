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
    if (!code.trim()) {
      setError("请填写卡密");
      return;
    }
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
    <section className="km-shell-narrow km-rx-body">
      <div className="km-rx-hero km-rise">
        <h1>卡密查询</h1>
        <p>输入卡密，查看是否已使用</p>
      </div>
      <div className="km-sf-query km-rise">
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="km-sf-query-title">查询卡密</h2>
          <p className="km-sf-query-desc">购买后订单页或邮箱查单里那一串</p>
          <div className="km-sf-query-row">
            <input
              className="km-input"
              placeholder="粘贴卡密"
              value={code}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void query();
              }}
              aria-label="卡密"
            />
            <button
              type="button"
              className="km-btn km-btn-sm km-sf-query-go"
              disabled={busy}
              onClick={() => void query()}
            >
              {busy ? "查询中…" : "查询"}
            </button>
          </div>
          {error ? <p className="km-sf-query-note" style={{ color: "var(--km-danger)" }}>{error}</p> : null}
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
      </div>
    </section>
  );
}
