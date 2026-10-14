"use client";

import { useEffect, useState } from "react";
import { formatDateTime } from "@/lib/datetime";
import Link from "next/link";
import { toast } from "@/components/toast";
import { copyText } from "@/lib/copy-text";
import { readApiJson } from "@/lib/http-error";
import { yuanTextFromCents } from "@/lib/money";
import { RegionBadge } from "@/components/region-badge";
import { regionDisplay } from "@/lib/cardplatform/regions";
import { isExternalRedeemUrl } from "@/lib/agent-redeem-core";
import { formatFinishedAccountLine } from "@/lib/finished-account-core";
import {
  looksLikeStoreQueryToken,
  pickStoreQueryToken,
} from "@/lib/store-order-access";
import {
  elapsedSeconds,
  formatWaitLabel,
  sessionWaitStorage,
  waitAnchor,
} from "@/lib/wait-clock";

type FinishedAccountView = {
  email: string;
  gptPassword: string;
  mailboxPassword: string;
  session: string;
};

type StoreOrderResult = {
  orderNo: string;
  productName: string;
  paymentCountry?: string | null;
  regionLabel?: string | null;
  codeCountries?: string[];
  quantity?: number;
  unitPriceCents?: number;
  amountCents: number;
  payStatus: string;
  fulfillStatus: string;
  message: string;
  deliveryKind?: "cdk" | "finished_account";
  code: string | null;
  codes?: string[];
  accounts?: FinishedAccountView[];
  rechargePath?: string;
  rechargeUrl?: string;
  queryToken?: string;
  referral?: ReferralView | null;
};

type ReferralView = {
  invite: {
    code: string;
    link: string;
    rule: string;
    rewardedCount: number;
    coolingCount: number;
  } | null;
  coupons: Array<{
    code: string;
    description: string;
    expiresAt: string;
    status: string;
    usedDiscountCents: number | null;
  }>;
};

const COUPON_STATUS_LABEL: Record<string, string> = {
  unused: "可使用",
  reserved: "下单中",
  used: "已使用",
  expired: "已过期",
  revoked: "已停用",
};

function useWaitSeconds(orderNo: string) {
  // 服务端渲染没有会话存储，锚点为 0，挂载后在 effect 里补上。
  const [anchor, setAnchor] = useState(() => {
    const storage = sessionWaitStorage();
    return storage ? waitAnchor(orderNo, storage) : 0;
  });
  // 初始值直接由锚点算出。等计时器首次触发的话，重挂快于间隔就会一直显示 0 秒。
  const [seconds, setSeconds] = useState(() => elapsedSeconds(anchor));

  useEffect(() => {
    let current = anchor;
    if (!current) {
      current = waitAnchor(orderNo, sessionWaitStorage());
      setAnchor(current);
    }
    const tick = () => setSeconds(elapsedSeconds(current));
    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [anchor, orderNo]);

  return seconds;
}

function OrderWait({
  orderNo,
  title,
  detail,
}: {
  orderNo: string;
  title: string;
  detail: string;
}) {
  const seconds = useWaitSeconds(orderNo);

  return (
    <div className="km-order-wait" role="status" aria-live="polite">
      <span className="km-spinner" aria-hidden />
      <p className="font-medium">{title}</p>
      <p className="max-w-[28ch] text-sm leading-6 text-[var(--km-fg-muted)]">
        {detail}
      </p>
      <p className="text-xs text-[var(--km-fg-muted)]">
        已等待 {formatWaitLabel(seconds)}，请不要关闭本页
      </p>
    </div>
  );
}

export function StoreOrderResultPanel({
  orderNo,
  token,
}: {
  orderNo: string;
  token: string;
}) {
  const [order, setOrder] = useState<StoreOrderResult | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const storageKey = `kaimi-order-token:${orderNo}`;
    const search = new URLSearchParams(window.location.search);
    const resolvedToken =
      pickStoreQueryToken(search) ||
      (looksLikeStoreQueryToken(token) ? token : "") ||
      window.sessionStorage.getItem(storageKey) ||
      "";
    if (resolvedToken) {
      search.set("qt", resolvedToken);
      window.sessionStorage.setItem(storageKey, resolvedToken);
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    async function load() {
      try {
        const data = await readApiJson<StoreOrderResult>(
          await fetch(
            `/api/public/store-orders/${encodeURIComponent(orderNo)}?${search.toString()}`,
            { cache: "no-store" },
          ),
        );
        if (stopped) return;
        if (data.queryToken && looksLikeStoreQueryToken(data.queryToken)) {
          window.sessionStorage.setItem(storageKey, data.queryToken);
        }
        setOrder(data);
        setError("");
        failures = 0;
        if (
          data.fulfillStatus !== "delivered" &&
          data.payStatus !== "refunded"
        ) {
          timer = setTimeout(
            load,
            data.fulfillStatus === "unknown" ? 15_000 : 3000,
          );
        }
      } catch (reason) {
        if (!stopped) {
          const message =
            reason instanceof Error ? reason.message : "订单查询失败";
          setError(message);
          if (
            message.includes("不存在") ||
            message.includes("凭证")
          ) {
            return;
          }
          failures += 1;
          timer = setTimeout(load, Math.min(3000 * failures, 15_000));
        }
      }
    }
    void load();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [orderNo, token]);

  async function copy(text: string, ok: string) {
    try {
      await copyText(text);
      toast(ok);
    } catch {
      toast("复制失败，请手动选择", "err");
    }
  }

  if (error) {
    return (
      <div className="km-order-card">
        <h1 className="km-order-title">订单 {orderNo}</h1>
        <p className="km-order-note">{error}</p>
      </div>
    );
  }
  if (!order) {
    return (
      <div className="km-order-card">
        <OrderWait
          orderNo={orderNo}
          title="正在确认订单"
          detail="支付完成后会自动开始发货，请稍候。"
        />
      </div>
    );
  }

  const finished = order.deliveryKind === "finished_account";
  const rechargePath = finished ? "" : order.rechargePath || "/recharge";
  const rechargeUrl = finished
    ? ""
    : order.rechargeUrl ||
      (!isExternalRedeemUrl(rechargePath) && typeof window !== "undefined"
        ? `${window.location.origin}${rechargePath}`
        : rechargePath);
  const accounts = order.accounts || [];
  const codes = finished
    ? []
    : order.codes?.length
      ? order.codes
      : order.code
        ? [order.code]
        : [];
  const delivered = finished ? accounts.length : codes.length;
  const quantity = Math.max(1, order.quantity || 1);
  const pending = quantity - delivered;
  const unit = finished ? "个" : "张";
  const showRegion = order.paymentCountry !== null && order.paymentCountry !== undefined && !finished;
  const region = showRegion
    ? regionDisplay(order.paymentCountry || "", order.regionLabel || "")
    : null;

  const status = orderHeadline(order, finished, pending);

  return (
    <div className="km-order-card km-rise">
      <header className="km-order-head">
        <span className={`km-order-status km-order-status-${status.tone}`}>{status.label}</span>
        <h1 className="km-order-title">{order.productName}</h1>
        <dl className="km-order-meta">
          <div>
            <dt>实付</dt>
            <dd>¥{yuanTextFromCents(order.amountCents)}</dd>
          </div>
          <div>
            <dt>数量</dt>
            <dd>
              {quantity} {unit}
            </dd>
          </div>
          {region ? (
            <div>
              <dt>地区</dt>
              <dd>
                <RegionBadge country={region.country} regionLabel={region.zh} />
              </dd>
            </div>
          ) : null}
          <div className="km-order-meta-no">
            <dt>订单号</dt>
            <dd>
              <span className="font-mono">{order.orderNo}</span>
              <button type="button" className="km-order-chip" onClick={() => void copy(order.orderNo, "订单号已复制")}>
                复制
              </button>
            </dd>
          </div>
        </dl>
      </header>

      {delivered ? (
        <>
          {finished ? (
            <section className="km-order-section">
              <div className="km-order-section-head">
                <h2>成品账号{quantity > 1 ? `（已出 ${accounts.length}/${quantity}）` : ""}</h2>
              </div>
              <p className="km-order-note">这不是卡密，不用兑换，直接登录使用。</p>
              {accounts.map((item, index) => (
                <FinishedAccountCard
                  key={`${item.email}-${index}`}
                  account={item}
                  index={accounts.length > 1 ? index + 1 : 0}
                  onCopy={copy}
                />
              ))}
            </section>
          ) : (
            <section className="km-order-section">
              <div className="km-order-section-head">
                <h2>卡密{quantity > 1 ? `（已出 ${codes.length}/${quantity}）` : ""}</h2>
                {codes.length > 1 ? (
                  <button
                    type="button"
                    className="km-order-chip"
                    onClick={() => void copy(codes.join("\n"), `${codes.length} 张卡密已复制`)}
                  >
                    复制全部
                  </button>
                ) : null}
              </div>
              <ul className="km-order-codes">
                {codes.map((item, index) => {
                  const country = order.codeCountries?.[index] ?? order.paymentCountry ?? "";
                  const mixed = Boolean(region) && (order.codeCountries || []).some((c) => c !== order.paymentCountry);
                  return (
                    <li key={item}>
                      <code>{item}</code>
                      {mixed ? <RegionBadge country={country} /> : null}
                      <button type="button" className="km-order-copy" onClick={() => void copy(item, "卡密已复制")}>
                        复制
                      </button>
                    </li>
                  );
                })}
              </ul>
              {region?.country ? <p className="km-order-note">兑换时按{region.zh}结账。</p> : null}
            </section>
          )}
          {pending > 0 ? (
            order.fulfillStatus === "unknown" ? (
              <p className="km-order-note">
                上面这几{unit}已经可以用了。剩下 {pending} {unit}我们正在确认，确认好会显示在本页。请不要重复付款。
              </p>
            ) : (
              <OrderWait
                orderNo={orderNo}
                title={`还有 ${pending} ${unit}正在发放`}
                detail={order.message || "上面这些已经可以用了。剩下的出好会自动显示在本页，不用刷新。"}
              />
            )
          ) : null}
          {!finished && rechargePath ? (
            <section className="km-order-next">
              <div>
                <h2>下一步：兑换开通</h2>
                <p>
                  {codes.length > 1
                    ? `兑换页会带上这一单的 ${codes.length} 张卡密，填一次账号就能一起开通。`
                    : "兑换页会自动带上这张卡密，校验后填 Session 就能开通。"}
                </p>
              </div>
              <div className="km-order-next-actions">
                <Link href={rechargePath} className="km-btn km-btn-primary">
                  去兑换开通
                </Link>
                <button type="button" className="km-btn km-btn-ghost" onClick={() => void copy(rechargeUrl, "兑换链接已复制")}>
                  复制兑换链接
                </button>
              </div>
            </section>
          ) : null}
          <p className="km-order-foot">请保存好{finished ? "账号" : "卡密"}。丢失后凭下单邮箱和订单号在店铺「邮箱查单」找回，发货邮件里也有。</p>
          {order.referral ? <ReferralSection view={order.referral} onCopy={copy} /> : null}
        </>
      ) : order.fulfillStatus === "unknown" ? (
        <p className="km-order-note">
          {order.message || "已收到你的付款，这一笔我们正在确认，确认好会把内容显示在本页。请不要重复付款。"}
        </p>
      ) : order.payStatus === "paid" ? (
        <OrderWait
          orderNo={orderNo}
          title={finished ? "正在发送账号，请稍候" : "正在生成卡密，请稍候"}
          detail={order.message || "一般几十秒，最多一两分钟。出好了会自动显示在本页，不用刷新。"}
        />
      ) : (
        <p className="km-order-note">{order.message || "等待支付完成。付款后本页会自动刷新。"}</p>
      )}
    </div>
  );
}

/** 卡片顶上那颗状态：买家只关心「拿到没有」，不用分别看支付和发货两个字段。 */
function orderHeadline(order: StoreOrderResult, finished: boolean, pending: number) {
  if (order.payStatus === "refunded") return { label: "已退款", tone: "muted" };
  if (order.payStatus === "closed") return { label: "已关闭", tone: "muted" };
  if (order.payStatus !== "paid" && order.payStatus !== "manual") return { label: "等待付款", tone: "wait" };
  if (order.fulfillStatus === "unknown") return { label: "付款成功 · 正在核对", tone: "wait" };
  if (order.fulfillStatus === "delivered" && pending <= 0) {
    return { label: finished ? "付款成功 · 账号已发" : "付款成功 · 卡密已发", tone: "ok" };
  }
  return { label: "付款成功 · 正在发货", tone: "wait" };
}

function FinishedAccountCard({
  account,
  index,
  onCopy,
}: {
  account: FinishedAccountView;
  index: number;
  onCopy: (text: string, ok: string) => Promise<void>;
}) {
  const fields = [
    { label: "邮箱账号", value: account.email, copy: "邮箱已复制" },
    { label: "GPT 密码", value: account.gptPassword, copy: "GPT 密码已复制" },
    { label: "邮箱密码", value: account.mailboxPassword, copy: "邮箱密码已复制" },
  ];
  return (
    <div className="km-order-account">
      {index ? (
        <p className="text-xs text-[var(--km-fg-muted)]">账号 {index}</p>
      ) : null}
      {fields.map((field) => (
        <div key={field.label} className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-[var(--km-fg-muted)]">{field.label}</p>
            <button
              type="button"
              className="km-btn km-btn-ghost px-2 py-1 text-xs"
              onClick={() => void onCopy(field.value, field.copy)}
            >
              复制
            </button>
          </div>
          <p className="break-all font-mono text-sm">{field.value}</p>
        </div>
      ))}
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-[var(--km-fg-muted)]">Session</p>
          <button
            type="button"
            className="km-btn km-btn-ghost px-2 py-1 text-xs"
            onClick={() => void onCopy(account.session, "Session 已复制")}
          >
            复制
          </button>
        </div>
        <p className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-5">
          {account.session}
        </p>
      </div>
      <button
        type="button"
        className="km-btn km-btn-ghost w-full"
        onClick={() =>
          void onCopy(formatFinishedAccountLine(account), "全部字段已复制")
        }
      >
        复制全部
      </button>
    </div>
  );
}

/** 邀请好友卡片和「我的优惠券」。能看到这一页的就是下单本人（有完整订单号或查询凭证）。 */
function ReferralSection({
  view,
  onCopy,
}: {
  view: ReferralView;
  onCopy: (text: string, ok: string) => Promise<void>;
}) {
  return (
    <>
      {view.invite ? (
        <section className="km-order-section">
          <div className="km-order-section-head">
            <h2>邀请好友，得邀请券</h2>
          </div>
          <p className="km-order-note">{view.invite.rule}</p>
          <ul className="km-order-codes">
            <li>
              <code>{view.invite.link}</code>
              <button type="button" className="km-order-copy" onClick={() => void onCopy(view.invite!.link, "邀请链接已复制，发给好友吧")}>
                复制
              </button>
            </li>
          </ul>
          <p className="km-order-note">
            你的邀请码 <span className="font-mono">{view.invite.code}</span>，好友没点链接也可以在下单时填。
            {view.invite.rewardedCount || view.invite.coolingCount
              ? ` 已邀请成功 ${view.invite.rewardedCount} 人${view.invite.coolingCount ? `，待到账 ${view.invite.coolingCount} 张` : ""}。`
              : ""}
          </p>
        </section>
      ) : null}
      {view.coupons.length ? (
        <section className="km-order-section">
          <div className="km-order-section-head">
            <h2>我的优惠券</h2>
          </div>
          <p className="km-order-note">下次在本店下单时，在「优惠券」里填券码，下单邮箱要用这一单的邮箱。</p>
          <ul className="km-order-codes">
            {view.coupons.map((coupon) => (
              <li key={coupon.code}>
                <code>{coupon.code}</code>
                <span className="text-xs text-[var(--km-fg-muted)]">
                  {coupon.description} · {COUPON_STATUS_LABEL[coupon.status] || coupon.status}
                  {coupon.status === "unused" ? ` · ${formatDateTime(coupon.expiresAt)} 前有效` : ""}
                </span>
                {coupon.status === "unused" ? (
                  <button type="button" className="km-order-copy" onClick={() => void onCopy(coupon.code, "券码已复制")}>
                    复制
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
