"use client";

import { useEffect, useState } from "react";

type Snapshot = {
  botConfigured: boolean;
  botUsername: string;
  telegramBound: boolean;
  telegramUsername: string;
  telegramNotifyEnabled: boolean;
  mailDeliveryEnabled: boolean;
  mailFromName: string;
  mailReplyTo: string;
  platformMailReady: boolean;
};

type BindResult = {
  code: string;
  expiresAt: string;
  botUsername: string;
};

export function AgentNotify() {
  const [form, setForm] = useState<Snapshot | null>(null);
  const [bind, setBind] = useState<BindResult | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function reload() {
    const response = await fetch("/api/agent/notify", { cache: "no-store" });
    const data = await response.json();
    if (response.ok) setForm(data);
  }

  useEffect(() => {
    void reload();
  }, []);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/agent/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存失败");
      if (body.action === "bind") {
        setBind(data);
        setMessage("绑定码 10 分钟内有效。发给机器人后等大约半分钟，再刷新状态。");
      } else {
        setForm(data);
        setBind(null);
        setMessage(body.action === "unbind" ? "已解除绑定" : "已保存");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  if (!form) return <p className="text-sm text-[var(--km-fg-muted)]">正在读取通知设置…</p>;

  const botName = bind?.botUsername || form.botUsername;
  const botLink = botName ? `https://t.me/${botName}` : "";

  return (
    <div className="space-y-4">
      <section className="km-panel space-y-3">
        <div>
          <h2 className="text-xl font-semibold">Telegram</h2>
          <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
            只收你自己店铺的通知：每笔付款（购买人、金额、套餐和你的收益，不含平台成本和毛利），以及付款 10 分钟后还没发出卡的订单提醒。
          </p>
        </div>
        {botName ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--km-accent)] bg-[color-mix(in_oklab,var(--km-accent)_8%,transparent)] p-3 text-sm">
            <div>
              <p>
                平台官方机器人：<span className="font-mono font-semibold">@{botName}</span>
              </p>
              <p className="mt-1 text-xs text-[var(--km-fg-muted)]">
                只能绑定这一个。搜索时认准用户名，名字相似的都不是平台的，发过去也绑不上。
              </p>
            </div>
            <a className="km-btn km-btn-ghost km-btn-sm" href={botLink} target="_blank" rel="noreferrer">
              打开 @{botName}
            </a>
          </div>
        ) : (
          <p className="text-sm text-[var(--km-fg-muted)]">
            {form.botConfigured
              ? "暂时读不到平台机器人的用户名，请联系平台确认。"
              : "平台还没配置 Telegram 机器人，暂时不能绑定。"}
          </p>
        )}
        <p className="text-sm">
          {form.telegramBound
            ? `已绑定${form.telegramUsername ? ` @${form.telegramUsername}` : ""}`
            : "还没绑定"}
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.telegramNotifyEnabled}
            onChange={(event) => setForm({ ...form, telegramNotifyEnabled: event.target.checked })}
          />
          接收下单通知
        </label>
        <div className="flex flex-wrap gap-2">
          <button className="km-btn" disabled={busy || !form.botConfigured} onClick={() => void post({ action: "bind" })}>
            生成绑定码
          </button>
          {form.telegramBound ? (
            <button className="km-btn km-btn-ghost" disabled={busy} onClick={() => void post({ action: "unbind" })}>
              解除绑定
            </button>
          ) : null}
          <button className="km-btn km-btn-ghost" disabled={busy} onClick={() => void reload()}>
            刷新状态
          </button>
        </div>
        {bind ? (
          <div className="rounded-lg border border-[var(--km-border)] p-3 text-sm">
            <p>
              打开{" "}
              {botLink ? (
                <a className="font-mono font-semibold underline underline-offset-2" href={botLink} target="_blank" rel="noreferrer">
                  @{botName}
                </a>
              ) : (
                "平台机器人"
              )}
              ，发送下面这一整行（包括 /bind 和空格）：
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <p className="font-mono text-base">/bind {bind.code}</p>
              <button
                type="button"
                className="km-btn km-btn-ghost km-btn-sm"
                onClick={() =>
                  void navigator.clipboard.writeText(`/bind ${bind.code}`).then(() => setMessage("已复制，粘贴发给机器人即可"))
                }
              >
                复制
              </button>
            </div>
            <p className="mt-2 text-xs text-[var(--km-fg-muted)]">
              {bind.expiresAt.replace("T", " ").slice(0, 16)} 前有效。机器人会回复「已绑定」，没回复就是发错了机器人或格式不对。一个店铺只绑一个聊天。
            </p>
          </div>
        ) : null}
      </section>

      <section className="km-panel space-y-3">
        <div>
          <h2 className="text-xl font-semibold">发给买家的邮件</h2>
          <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
            发信地址由平台统一。你可以改买家看到的名称，以及回复时回到哪个邮箱。邮件里只有订单号和交付内容。
          </p>
          <p className="text-sm text-[var(--km-fg-muted)]">
            {form.platformMailReady
              ? "平台已开启发货邮件。关掉发货开关后，你的买家不会收到。"
              : "平台还没开启发货邮件。你这里先保存，等平台打开后才会寄出。"}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.mailDeliveryEnabled}
            onChange={(event) => setForm({ ...form, mailDeliveryEnabled: event.target.checked })}
          />
          付款交付后给买家发邮件
        </label>
        <label className="block space-y-1 text-sm">
          发件人名称
          <input
            className="km-input w-full"
            maxLength={80}
            placeholder="买家看到的名字，例如 For-Vibe-Coding"
            value={form.mailFromName}
            onChange={(event) => setForm({ ...form, mailFromName: event.target.value })}
          />
        </label>
        <label className="block space-y-1 text-sm">
          回复邮箱
          <input
            className="km-input w-full"
            placeholder="买家点回复时使用"
            value={form.mailReplyTo}
            onChange={(event) => setForm({ ...form, mailReplyTo: event.target.value })}
          />
        </label>
        <button
          className="km-btn"
          disabled={busy}
          onClick={() =>
            void post({
              action: "save",
              telegramNotifyEnabled: form.telegramNotifyEnabled,
              mailDeliveryEnabled: form.mailDeliveryEnabled,
              mailFromName: form.mailFromName,
              mailReplyTo: form.mailReplyTo,
            })
          }
        >
          保存
        </button>
      </section>
      {message ? <p className="text-sm">{message}</p> : null}
    </div>
  );
}
