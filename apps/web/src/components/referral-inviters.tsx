"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { toast } from "@/components/toast";
import { formatDateTime } from "@/lib/datetime";
import { readApiJson } from "@/lib/http-error";
import { yuanTextFromCents } from "@/lib/money";
import { hasNextPage, pageLabel } from "@/lib/pagination-core";
// 表格、状态点、文字按钮的样式在代理台样式里；管理端也用这个组件，所以这里直接引入。
import "./agent-console.css";

type Inviter = {
  codeId: number;
  code: string;
  email: string;
  createdAt: string;
  rewardedCount: number;
  coolingCount: number;
  cappedCount: number;
  voidCount: number;
  couponCount: number;
  usedCount: number;
  discountCents: number;
};

type InviterDetail = {
  codeId: number;
  code: string;
  email: string;
  referrals: Array<{
    id: number;
    status: string;
    voidReason: string;
    qualifyAt: string;
    orderAmountCents: number;
    inviteeEmail: string;
    createdAt: string;
    orderNo: string;
  }>;
  coupons: Array<{
    id: number;
    code: string;
    status: string;
    description: string;
    expiresAt: string;
    usedDiscountCents: number | null;
    revokedReason: string;
    createdAt: string;
    usedOrderNo: string | null;
  }>;
};

const PAGE_SIZE = 20;

export const REFERRAL_STATUS: Record<string, { label: string; tone: string }> = {
  cooling: { label: "冷静期中", tone: " warn" },
  rewarded: { label: "已发券", tone: "" },
  capped: { label: "超出上限", tone: " mute" },
  void: { label: "已作废", tone: " mute" },
};

const VOID_REASON: Record<string, string> = {
  refunded: "好友订单退款",
  refunded_after_reward: "发券后好友订单退款",
  monthly_cap: "邀请人本月已拿满",
  no_rewards: "发券时没有可用商品",
  code_missing: "邀请码不存在",
};

export const COUPON_STATUS: Record<string, { label: string; tone: string }> = {
  unused: { label: "未使用", tone: "" },
  reserved: { label: "下单中", tone: " warn" },
  used: { label: "已使用", tone: " mute" },
  expired: { label: "已过期", tone: " mute" },
  revoked: { label: "已停用", tone: " bad" },
};

function Status({ map, value }: { map: Record<string, { label: string; tone: string }>; value: string }) {
  const item = map[value] || { label: value, tone: " mute" };
  return <span className={`km-acp-status${item.tone}`}>{item.label}</span>;
}

/** 邀请人列表，点开看邀请记录和券。代理端、管理端共用，只是接口地址不同。 */
export function ReferralInviters({
  listUrl,
  detailUrl,
  revokeUrl,
  refreshKey = 0,
}: {
  listUrl: string;
  detailUrl: (codeId: number) => string;
  revokeUrl: (couponId: number) => string;
  refreshKey?: number;
}) {
  const [list, setList] = useState<Inviter[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<InviterDetail | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (query) qs.set("q", query);
      const data = await readApiJson<{ list: Inviter[]; total: number }>(
        await fetch(`${listUrl}?${qs}`, { cache: "no-store" }),
      );
      setList(data.list || []);
      setTotal(Number(data.total) || 0);
    } catch (error) {
      toast(error instanceof Error ? error.message : "加载失败", "err");
    } finally {
      setLoading(false);
    }
  }, [listUrl, page, query]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function toggle(codeId: number) {
    if (open?.codeId === codeId) {
      setOpen(null);
      return;
    }
    try {
      setOpen(await readApiJson<InviterDetail>(await fetch(detailUrl(codeId), { cache: "no-store" })));
    } catch (error) {
      toast(error instanceof Error ? error.message : "加载失败", "err");
    }
  }

  async function revoke(couponId: number, code: string) {
    const reason = window.prompt(`停用券 ${code}，买家就不能再用了。请填写原因：`);
    if (!reason?.trim()) return;
    try {
      await readApiJson(
        await fetch(revokeUrl(couponId), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        }),
      );
      toast("已停用");
      if (open) {
        setOpen(await readApiJson<InviterDetail>(await fetch(detailUrl(open.codeId), { cache: "no-store" })));
      }
      void load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "停用失败", "err");
    }
  }

  function search(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setQuery(q.trim());
  }

  return (
    <div className="space-y-3">
      <form className="flex flex-wrap items-center gap-2" onSubmit={search}>
        <input
          className="km-input max-w-xs"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="邀请人邮箱、邀请码或券码"
        />
        <button type="submit" className="km-btn km-btn-ghost km-btn-sm">
          搜索
        </button>
        {query ? (
          <button
            type="button"
            className="km-acp-link"
            onClick={() => {
              setQ("");
              setQuery("");
              setPage(1);
            }}
          >
            清除
          </button>
        ) : null}
      </form>
      <div className="overflow-x-auto">
        <table className="km-acp-orders">
          <thead>
            <tr>
              <th>邀请人</th>
              <th className="num">成功邀请</th>
              <th className="num">冷静期中</th>
              <th className="num">已发券</th>
              <th className="num">已用</th>
              <th className="num">让利合计</th>
              <th className="act" aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {list.map((row) => (
              <InviterRow
                key={row.codeId}
                row={row}
                open={open?.codeId === row.codeId ? open : null}
                onToggle={() => void toggle(row.codeId)}
                onRevoke={(couponId, code) => void revoke(couponId, code)}
              />
            ))}
          </tbody>
        </table>
        {!list.length && !loading ? (
          <p className="py-8 text-center text-sm text-[var(--km-fg-muted)]">
            {query ? "没有匹配的邀请人" : "还没有买家邀请成功过"}
          </p>
        ) : null}
      </div>
      {total > PAGE_SIZE ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--km-border)] pt-3 text-sm">
          <span className="text-[var(--km-fg-muted)]">{pageLabel(total, page, PAGE_SIZE)}</span>
          <div className="flex gap-2">
            <button
              type="button"
              className="km-btn km-btn-ghost km-btn-sm"
              disabled={page <= 1}
              onClick={() => setPage((current) => current - 1)}
            >
              上一页
            </button>
            <button
              type="button"
              className="km-btn km-btn-ghost km-btn-sm"
              disabled={!hasNextPage(total, page, PAGE_SIZE)}
              onClick={() => setPage((current) => current + 1)}
            >
              下一页
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function InviterRow({
  row,
  open,
  onToggle,
  onRevoke,
}: {
  row: Inviter;
  open: InviterDetail | null;
  onToggle: () => void;
  onRevoke: (couponId: number, code: string) => void;
}) {
  return (
    <>
      <tr>
        <td>
          <span className="block text-sm">{row.email || "—"}</span>
          <span className="sub">邀请码 {row.code}</span>
        </td>
        <td className="num">{row.rewardedCount + row.coolingCount}</td>
        <td className="num">{row.coolingCount || "—"}</td>
        <td className="num">{row.couponCount}</td>
        <td className="num">{row.usedCount}</td>
        <td className="num">{row.discountCents ? `¥${yuanTextFromCents(row.discountCents)}` : "—"}</td>
        <td className="act">
          <button type="button" className="km-acp-link" onClick={onToggle}>
            {open ? "收起" : "明细"}
          </button>
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={7} className="bg-[var(--km-bg-muted)]">
            <div className="space-y-4 p-2">
              <div>
                <p className="mb-1 text-xs font-semibold text-[var(--km-fg-muted)]">邀请记录</p>
                {open.referrals.length ? (
                  <table className="km-acp-orders">
                    <tbody>
                      {open.referrals.map((item) => (
                        <tr key={item.id}>
                          <td>
                            <span className="block text-sm">{item.inviteeEmail || "—"}</span>
                            <span className="sub">
                              {item.orderNo} · {formatDateTime(item.createdAt)}
                            </span>
                          </td>
                          <td className="num">¥{yuanTextFromCents(item.orderAmountCents)}</td>
                          <td>
                            <Status map={REFERRAL_STATUS} value={item.status} />
                            {item.status === "cooling" ? (
                              <span className="hint">{formatDateTime(item.qualifyAt)} 后发券</span>
                            ) : item.voidReason ? (
                              <span className="hint">{VOID_REASON[item.voidReason] || item.voidReason}</span>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="text-sm text-[var(--km-fg-muted)]">没有邀请记录</p>
                )}
              </div>
              <div>
                <p className="mb-1 text-xs font-semibold text-[var(--km-fg-muted)]">邀请券</p>
                {open.coupons.length ? (
                  <table className="km-acp-orders">
                    <tbody>
                      {open.coupons.map((coupon) => (
                        <tr key={coupon.id}>
                          <td>
                            <span className="no">{coupon.code}</span>
                            <span className="sub">{coupon.description}</span>
                          </td>
                          <td>
                            <span className="sub">发券 {formatDateTime(coupon.createdAt)}</span>
                            <span className="sub">到期 {formatDateTime(coupon.expiresAt)}</span>
                          </td>
                          <td>
                            <Status map={COUPON_STATUS} value={coupon.status} />
                            {coupon.status === "used" ? (
                              <span className="hint">
                                {coupon.usedOrderNo} 减 ¥{yuanTextFromCents(coupon.usedDiscountCents || 0)}
                              </span>
                            ) : coupon.revokedReason ? (
                              <span className="hint">{coupon.revokedReason}</span>
                            ) : null}
                          </td>
                          <td className="act">
                            {coupon.status === "unused" ? (
                              <button type="button" className="km-acp-link" onClick={() => onRevoke(coupon.id, coupon.code)}>
                                停用
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="text-sm text-[var(--km-fg-muted)]">还没发券</p>
                )}
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
