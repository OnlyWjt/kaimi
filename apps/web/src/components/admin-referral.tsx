"use client";

import { useEffect, useState } from "react";
import { ReferralInviters } from "@/components/referral-inviters";
import { useAskDialog } from "@/components/ask-dialog";
import { toast } from "@/components/toast";
import { readApiJson } from "@/lib/http-error";
import { yuanTextFromCents } from "@/lib/money";

type Summary = {
  invitedCount: number;
  invitedAmountCents: number;
  coolingCount: number;
  issuedCount: number;
  usedCount: number;
  expiredCount: number;
  discountCents: number;
};

type Overview = {
  total: Summary;
  month: Summary;
  agents: Array<{
    agentId: number;
    name: string;
    enabled: boolean;
    disabledByAdmin: boolean;
    month: Summary;
    total: Summary;
  }>;
  flagged: Array<{
    agentId: number;
    agentName: string;
    codeId: number;
    code: string;
    email: string;
    monthCount: number;
    cappedCount: number;
    voidCount: number;
  }>;
};

const yuan = (cents: number) => `¥${yuanTextFromCents(cents)}`;

/** 管理端「邀请返券」：全站汇总、按代理看、关活动、停券。不能改代理的面额。 */
export function AdminReferral() {
  const { ask, dialog } = useAskDialog();
  const [data, setData] = useState<Overview | null>(null);
  const [agentId, setAgentId] = useState(0);
  const [busy, setBusy] = useState(false);

  async function load() {
    setData(await readApiJson<Overview>(await fetch("/api/admin/referral", { cache: "no-store" })));
  }

  useEffect(() => {
    void load().catch((error) => toast(error instanceof Error ? error.message : "加载失败", "err"));
  }, []);

  async function disable(id: number, name: string) {
    const answer = await ask({
      title: `关闭「${name}」的邀请有礼`,
      message: "之后不再记新邀请；已发的券到期前照常能用，代理不能自己再打开。",
      confirmLabel: "关闭",
      danger: true,
    });
    if (!answer) return;
    setBusy(true);
    try {
      await readApiJson(await fetch(`/api/admin/referral/agents/${id}/disable`, { method: "POST" }));
      toast("已关闭");
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "关闭失败", "err");
    } finally {
      setBusy(false);
    }
  }

  async function restore(id: number, name: string) {
    const answer = await ask({
      title: `解除对「${name}」的关闭`,
      message: "代理可以在自己后台重新开启邀请有礼，平台不会替他开。",
      confirmLabel: "解除",
    });
    if (!answer) return;
    setBusy(true);
    try {
      await readApiJson(await fetch(`/api/admin/referral/agents/${id}/restore`, { method: "POST" }));
      toast("已恢复，代理可以自己重新开启");
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "恢复失败", "err");
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <p className="text-sm text-[var(--km-fg-muted)]">正在读取…</p>;
  const selected = data.agents.find((row) => row.agentId === agentId) || null;

  return (
    <div className="space-y-4">
      {dialog}
      <section className="grid gap-3 sm:grid-cols-4">
        {[
          ["开启的代理", String(data.agents.filter((row) => row.enabled).length), `开过 ${data.agents.length} 个`],
          ["本月带来新客", String(data.month.invitedCount), `成交 ${yuan(data.month.invitedAmountCents)}`],
          ["本月发券 / 用券", `${data.month.issuedCount} / ${data.month.usedCount}`, `冷静期中 ${data.month.coolingCount}`],
          ["本月让利", yuan(data.month.discountCents), `累计 ${yuan(data.total.discountCents)}`],
        ].map(([label, value, sub]) => (
          <div key={label} className="km-stat">
            <p className="text-xs text-[var(--km-fg-muted)]">{label}</p>
            <p className="km-stat-value">{value}</p>
            <p className="text-xs text-[var(--km-fg-muted)]">{sub}</p>
          </div>
        ))}
      </section>

      <section className="km-panel space-y-3">
        <h2 className="font-semibold">按代理</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--km-border)] text-xs text-[var(--km-fg-muted)]">
                <th className="py-2 pr-3">代理</th>
                <th className="py-2 pr-3">状态</th>
                <th className="py-2 pr-3 text-right">本月新客</th>
                <th className="py-2 pr-3 text-right">本月发券 / 用券</th>
                <th className="py-2 pr-3 text-right">本月让利</th>
                <th className="py-2 pr-3 text-right">累计让利</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {data.agents.map((row) => (
                <tr key={row.agentId} className="border-b border-[var(--km-border)]">
                  <td className="py-2 pr-3">{row.name}</td>
                  <td className="py-2 pr-3">
                    {row.enabled ? "进行中" : row.disabledByAdmin ? "平台已关闭" : "代理已关闭"}
                  </td>
                  <td className="py-2 pr-3 text-right">{row.month.invitedCount}</td>
                  <td className="py-2 pr-3 text-right">
                    {row.month.issuedCount} / {row.month.usedCount}
                  </td>
                  <td className="py-2 pr-3 text-right">{yuan(row.month.discountCents)}</td>
                  <td className="py-2 pr-3 text-right">{yuan(row.total.discountCents)}</td>
                  <td className="py-2 text-right whitespace-nowrap">
                    <button
                      type="button"
                      className="km-btn km-btn-ghost km-btn-sm"
                      onClick={() => setAgentId(agentId === row.agentId ? 0 : row.agentId)}
                    >
                      {agentId === row.agentId ? "收起" : "明细"}
                    </button>{" "}
                    {row.enabled ? (
                      <button
                        type="button"
                        className="km-btn km-btn-ghost km-btn-sm"
                        disabled={busy}
                        onClick={() => void disable(row.agentId, row.name)}
                      >
                        关闭活动
                      </button>
                    ) : row.disabledByAdmin ? (
                      <button
                        type="button"
                        className="km-btn km-btn-ghost km-btn-sm"
                        disabled={busy}
                        onClick={() => void restore(row.agentId, row.name)}
                      >
                        恢复
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data.agents.length ? (
            <p className="py-6 text-center text-sm text-[var(--km-fg-muted)]">还没有代理开过邀请有礼</p>
          ) : null}
        </div>
      </section>

      {selected ? (
        <section className="km-panel space-y-3">
          <h2 className="font-semibold">{selected.name} 的买家邀请</h2>
          <ReferralInviters
            key={selected.agentId}
            listUrl={`/api/admin/referral/agents/${selected.agentId}/inviters`}
            detailUrl={(codeId) => `/api/admin/referral/agents/${selected.agentId}/inviters/${codeId}`}
            revokeUrl={(couponId) => `/api/admin/referral/coupons/${couponId}/revoke`}
          />
        </section>
      ) : null}

      <section className="km-panel space-y-3">
        <div>
          <h2 className="font-semibold">需要看一眼</h2>
          <p className="text-xs text-[var(--km-fg-muted)]">本月拿满上限、或被邀请订单作废 2 单以上的邀请人。</p>
        </div>
        {data.flagged.length ? (
          <table className="w-full text-left text-sm">
            <tbody>
              {data.flagged.map((row) => (
                <tr key={row.codeId} className="border-b border-[var(--km-border)]">
                  <td className="py-2 pr-3">{row.agentName}</td>
                  <td className="py-2 pr-3">
                    {row.email} <span className="text-xs text-[var(--km-fg-muted)]">邀请码 {row.code}</span>
                  </td>
                  <td className="py-2 pr-3">
                    本月邀请 {row.monthCount} · 超上限 {row.cappedCount} · 作废 {row.voidCount}
                  </td>
                  <td className="py-2 text-right">
                    <button type="button" className="km-btn km-btn-ghost km-btn-sm" onClick={() => setAgentId(row.agentId)}>
                      去看
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-[var(--km-fg-muted)]">暂时没有</p>
        )}
      </section>
    </div>
  );
}
