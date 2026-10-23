"use client";

import { FormEvent, useEffect, useState } from "react";
import { toast } from "@/components/toast";
import { readApiJson } from "@/lib/http-error";
import { invoiceSurchargeAtRate, splitInvoiceSurcharge } from "@/lib/invoice-core";

type Snapshot = {
  customEnabled: boolean;
  effectiveRatePct: number;
  ratePct: number;
  defaultRatePct: number;
  platformRatePct: number;
  minRatePct: number;
  maxRatePct: number;
  agentTaxBp: number;
};

const SAMPLE_GOODS_CENTS = 10000;

function yuan(cents: number) {
  return `¥${(cents / 100).toFixed(2)}`;
}

/** 店铺设置页的开票税点。没开通时只告诉代理现在是 10%，开通后才能改。 */
export function AgentInvoiceRate() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [rate, setRate] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/agent/invoice-rate", { cache: "no-store" })
      .then((response) => readApiJson<Snapshot>(response))
      .then((next) => {
        setData(next);
        setRate(String(next.customEnabled ? next.ratePct : next.effectiveRatePct));
      })
      .catch(() => undefined);
  }, []);

  if (!data) return null;
  const parsed = Number(rate);
  const valid = /^\d+$/.test(rate.trim()) && parsed >= data.minRatePct && parsed <= data.maxRatePct;
  const dirty = valid && parsed !== data.ratePct;
  // 输入不合法时票面按已保存的税点算，不跟着乱跳
  const shownRate = data.customEnabled && valid ? parsed : data.effectiveRatePct;
  const taxPct = data.agentTaxBp / 100;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!valid) {
      toast(`请填 ${data!.minRatePct}–${data!.maxRatePct} 的整数`, "err");
      return;
    }
    setBusy(true);
    try {
      const next = await readApiJson<Snapshot>(
        await fetch("/api/agent/invoice-rate", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ratePct: parsed }),
        }),
      );
      setData(next);
      setRate(String(next.ratePct));
      toast(`开票税点已改为 ${next.ratePct}%，之后的开票单按这个算`);
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "保存失败", "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void save(event)} className="km-panel space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">开票税点</h2>
          <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
            {data.customEnabled
              ? `买家勾选开票后，实付按这个比例上浮。平台收 ${data.platformRatePct}%，多出来的扣税后归你。`
              : `买家勾选开票后，实付上浮 ${data.defaultRatePct}%，这笔加价归平台。`}
          </p>
        </div>
        <span className={`km-acp-pill${data.customEnabled ? "" : " mute"}`}>
          {data.customEnabled ? "已开通自定义" : "未开通自定义"}
        </span>
      </div>

      <div className="km-rate-layout">
        <div className="space-y-2">
          {data.customEnabled ? (
            <>
              <span className="block text-sm">税点</span>
              <div className="km-rate-field">
                <label className="km-rate-input">
                  <input
                    className="km-input"
                    inputMode="numeric"
                    aria-label="开票税点"
                    aria-invalid={!valid}
                    value={rate}
                    onChange={(event) => setRate(event.target.value)}
                  />
                  <span>%</span>
                </label>
                <button
                  type="submit"
                  className={`km-btn ${dirty ? "km-btn-primary" : "km-btn-ghost"}`}
                  disabled={busy || !dirty}
                >
                  {busy ? "保存中…" : valid && !dirty ? "已保存" : "保存"}
                </button>
              </div>
              <p className={`text-xs ${valid ? "text-[var(--km-fg-muted)]" : "text-[var(--km-danger)]"}`}>
                {valid
                  ? `可填 ${data.minRatePct}–${data.maxRatePct} 的整数。改了只影响之后的开票单。`
                  : `请填 ${data.minRatePct}–${data.maxRatePct} 的整数`}
              </p>
            </>
          ) : (
            <>
              <span className="block text-sm text-[var(--km-fg-muted)]">当前税点</span>
              <p className="km-rate-big">{data.effectiveRatePct}%</p>
              <p className="text-xs text-[var(--km-fg-muted)]">想自己调税点（{data.minRatePct}%–{data.maxRatePct}%），请联系平台开通。</p>
            </>
          )}
        </div>

        <div className="km-rate-receipt">
          <p>
            商品 {yuan(SAMPLE_GOODS_CENTS)}，买家开票实付{" "}
            {yuan(SAMPLE_GOODS_CENTS + invoiceSurchargeAtRate(SAMPLE_GOODS_CENTS, shownRate))}
          </p>
          {data.customEnabled ? (
            <InvoiceSplitRows rate={shownRate} platformRatePct={data.platformRatePct} agentTaxBp={data.agentTaxBp} taxPct={taxPct} />
          ) : (
            <dl>
              <div>
                <dt>开票加价 {data.effectiveRatePct}%</dt>
                <dd>{yuan(invoiceSurchargeAtRate(SAMPLE_GOODS_CENTS, data.effectiveRatePct))}</dd>
              </div>
              <div>
                <dt>全部归平台</dt>
                <dd>−{yuan(invoiceSurchargeAtRate(SAMPLE_GOODS_CENTS, data.effectiveRatePct))}</dd>
              </div>
              <div className="is-total">
                <dt>你多拿</dt>
                <dd>{yuan(0)}</dd>
              </div>
            </dl>
          )}
        </div>
      </div>
    </form>
  );
}

function InvoiceSplitRows({
  rate,
  platformRatePct,
  agentTaxBp,
  taxPct,
}: {
  rate: number;
  platformRatePct: number;
  agentTaxBp: number;
  taxPct: number;
}) {
  const split = splitInvoiceSurcharge(SAMPLE_GOODS_CENTS, { split: true, ratePct: rate, agentTaxBp });
  return (
    <>
      <dl>
        <div>
          <dt>开票加价 {rate}%</dt>
          <dd>{yuan(split.surchargeCents)}</dd>
        </div>
        <div>
          <dt>平台收 {platformRatePct}%</dt>
          <dd>−{yuan(split.platformCents)}</dd>
        </div>
        <div>
          <dt>扣税 {taxPct}%</dt>
          <dd>−{yuan(split.agentTaxCents)}</dd>
        </div>
        <div className="is-total">
          <dt>你多拿</dt>
          <dd>{yuan(split.agentNetCents)}</dd>
        </div>
      </dl>
      <p className="text-xs" style={{ margin: "0.6rem 0 0" }}>
        这类开票单的通道手续费按整单实付算，从你的收益里扣。
      </p>
    </>
  );
}
