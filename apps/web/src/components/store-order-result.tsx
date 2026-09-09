"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "@/components/toast";
import { copyText } from "@/lib/copy-text";
import { readApiJson } from "@/lib/http-error";
import { yuanTextFromCents } from "@/lib/money";
import { publicStatusLabel } from "@/lib/status-labels";
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

  if (error) return <div className="km-panel mx-auto max-w-[560px]">{error}</div>;
  if (!order) {
    return (
      <div className="km-panel mx-auto max-w-[560px]">
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

  return (
    <div className="km-panel km-rise mx-auto max-w-[560px] space-y-5">
      <div>
        <h2 className="text-xl font-semibold">{order.productName}</h2>
        <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
          ¥{yuanTextFromCents(order.amountCents)}
          {quantity > 1 ? ` · ${quantity} ${unit}` : ""} · 支付{" "}
          {publicStatusLabel(order.payStatus, "pay")} · 发货{" "}
          {publicStatusLabel(order.fulfillStatus, "fulfill")}
        </p>
        <p className="mt-1 font-mono text-xs text-[var(--km-fg-muted)]">{order.orderNo}</p>
      </div>
      {delivered ? (
        <>
          {finished ? (
            <div className="space-y-4">
              <p className="font-medium">
                成品账号{quantity > 1 ? `（已出 ${accounts.length}/${quantity}）` : ""}
              </p>
              <p className="text-sm text-[var(--km-fg-muted)]">
                这不是卡密，无需兑换。请保存，丢失后只能用本页或邮箱查单找回。
              </p>
              {accounts.map((item, index) => (
                <FinishedAccountCard
                  key={`${item.email}-${index}`}
                  account={item}
                  index={accounts.length > 1 ? index + 1 : 0}
                  onCopy={copy}
                />
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              <p className="font-medium">
                卡密{quantity > 1 ? `（已出 ${codes.length}/${quantity}）` : ""}
              </p>
              <p className="text-sm text-[var(--km-fg-muted)]">请保存，丢失后只能用本页或邮箱查单找回。</p>
              {codes.map((item) => (
                <div
                  key={item}
                  className="break-all rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 font-mono text-sm"
                >
                  {item}
                </div>
              ))}
              <button
                type="button"
                className="km-btn km-btn-ghost w-full"
                onClick={() =>
                  void copy(
                    codes.join("\n"),
                    codes.length > 1 ? `${codes.length} 张卡密已复制` : "卡密已复制",
                  )
                }
              >
                {codes.length > 1 ? "复制全部卡密" : "复制卡密"}
              </button>
            </div>
          )}
          {pending > 0 ? (
            order.fulfillStatus === "unknown" ? (
              <p className="text-sm text-[var(--km-fg-muted)]">
                上面这几{unit}已经可以用了。剩下 {pending} {unit}我们正在确认，确认好会显示在本页。请不要重复付款。
              </p>
            ) : (
              <OrderWait
                orderNo={orderNo}
                title={`还有 ${pending} ${unit}正在发放`}
                detail={
                  order.message ||
                  "上面这些已经可以用了。剩下的出好会自动显示在本页，不用刷新。"
                }
              />
            )
          ) : null}
          {!finished && rechargePath ? (
            <div className="space-y-2">
              <p className="font-medium">兑换链接</p>
              <p className="text-sm text-[var(--km-fg-muted)]">
                {codes.length > 1
                  ? `打开后会带上这一单的 ${codes.length} 张卡密，填一次账号就能一起兑换。`
                  : "打开后会带上这张卡密，直接校验即可兑换。"}
              </p>
              <div className="break-all rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 font-mono text-xs">
                {rechargeUrl}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  className="km-btn km-btn-ghost w-full"
                  onClick={() => void copy(rechargeUrl, "兑换链接已复制")}
                >
                  复制兑换链接
                </button>
                <Link href={rechargePath} className="km-btn km-btn-primary w-full">
                  去兑换
                </Link>
              </div>
            </div>
          ) : null}
        </>
      ) : order.fulfillStatus === "unknown" ? (
        <p className="text-sm text-[var(--km-fg-muted)]">
          {order.message ||
            "已收到你的付款，这一笔我们正在确认，确认好会把内容显示在本页。请不要重复付款。"}
        </p>
      ) : order.payStatus === "paid" ? (
        <OrderWait
          orderNo={orderNo}
          title={finished ? "正在发送账号，请稍候" : "正在生成卡密，请稍候"}
          detail={
            order.message ||
            "一般几十秒，最多一两分钟。出好了会自动显示在本页，不用刷新。"
          }
        />
      ) : (
        <p className="text-sm text-[var(--km-fg-muted)]">
          {order.message || "等待支付完成。"}
        </p>
      )}
    </div>
  );
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
    <div className="space-y-3 rounded-2xl bg-[var(--km-bg-muted)] px-3 py-3">
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
