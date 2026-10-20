"use client";

import { useEffect, useState } from "react";
import { loadAdminSection, postAdminAction } from "@/components/admin-api";
import { AdminFolioSettings } from "@/components/admin-folio-settings";
import { AdminMailSettings, AdminTelegramBindings } from "@/components/admin-mail-settings";
import { AdminMailTemplates } from "@/components/admin-mail-templates";
import { CardIntegration } from "@/components/card-integration";
import { KmSelect } from "@/components/km-select";
import { toast } from "@/components/toast";
import { THEME_CHOICES } from "@/lib/themes";

type Integration = {
  publicBaseUrl: string;
  /** 卡台 Webhook 要填的地址前缀：配了支付回调地址就是它，否则同公网地址。 */
  callbackBaseUrl?: string;
  notifyWebhookUrl?: string;
  telegramBotTokenConfigured?: boolean;
  telegramChatId?: string;
};

type IntegrationForm = {
  publicBaseUrl: string;
  notifyWebhookUrl: string;
  telegramBotToken: string;
  telegramChatId: string;
};

const PUBLIC_URL_HINT =
  "买家看到的订单页、兑换链接、查单邮件都用这个地址，填代理店铺的正式域名，不能填 localhost。「接入卡台」和「通知」两页改的是同一项。易支付和卡台回调可以在「卖卡 › 售卖设置」里另配一个回调地址。";

/** 「接入卡台」「通知」两页共用：公网地址、终态通知、Telegram 都存在 integration 这一节里。 */
function useIntegration() {
  const [integration, setIntegration] = useState<Integration | null>(null);
  const [form, setForm] = useState<IntegrationForm>({
    publicBaseUrl: "",
    notifyWebhookUrl: "",
    telegramBotToken: "",
    telegramChatId: "",
  });
  const [busy, setBusy] = useState(false);

  async function reload() {
    const data = await loadAdminSection<Integration>("integration");
    setIntegration(data);
    if (data) {
      setForm({
        publicBaseUrl: data.publicBaseUrl || "",
        notifyWebhookUrl: data.notifyWebhookUrl || "",
        telegramBotToken: "",
        telegramChatId: data.telegramChatId || "",
      });
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function run(action: "save_integration" | "test_notify") {
    setBusy(true);
    try {
      await postAdminAction({ action, ...form });
      if (action === "save_integration") await reload();
    } finally {
      setBusy(false);
    }
  }

  return { integration, form, setForm, busy, save: () => run("save_integration"), test: () => run("test_notify") };
}

function PublicUrlField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <label className="block space-y-1 text-sm">
      <span>本站公网地址</span>
      <input
        className="km-input"
        placeholder="https://kaimi.example.com"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="text-xs text-[var(--km-fg-muted)]">{PUBLIC_URL_HINT}</span>
    </label>
  );
}

export function AdminIntegration() {
  const { integration, form, setForm, busy, save } = useIntegration();
  if (!integration) return null;
  return (
    <div className="space-y-4">
      <CardIntegration publicBaseUrl={integration.callbackBaseUrl || form.publicBaseUrl} />
      <div className="km-panel space-y-3">
        <PublicUrlField
          value={form.publicBaseUrl}
          onChange={(publicBaseUrl) => setForm((s) => ({ ...s, publicBaseUrl }))}
        />
        <button className="km-btn" disabled={busy} onClick={() => void save()}>
          保存公网地址
        </button>
      </div>
    </div>
  );
}

export function AdminNotify() {
  const { integration, form, setForm, busy, save, test } = useIntegration();
  if (!integration) return null;
  return (
    <div className="space-y-4">
      <div className="km-panel space-y-4">
        <div>
          <h2 className="text-xl font-semibold" style={{ fontFamily: "var(--font-sora)" }}>
            站点通知
          </h2>
          <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
            管理员收每一笔付款和每一次兑换成功。代理只收自己店铺的付款，文案不含成本和毛利。Webhook 只发给这里。
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <PublicUrlField
            value={form.publicBaseUrl}
            onChange={(publicBaseUrl) => setForm((s) => ({ ...s, publicBaseUrl }))}
          />
          <label className="block space-y-1 text-sm">
            <span>终态通知地址（可选）</span>
            <input
              className="km-input"
              placeholder="https://example.com/notify"
              value={form.notifyWebhookUrl}
              onChange={(e) => setForm((s) => ({ ...s, notifyWebhookUrl: e.target.value }))}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>Telegram Token（可选）</span>
            <input
              className="km-input font-mono"
              type="password"
              placeholder={integration.telegramBotTokenConfigured ? "留空则不修改" : "123456:ABC…"}
              value={form.telegramBotToken}
              onChange={(e) => setForm((s) => ({ ...s, telegramBotToken: e.target.value }))}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>Telegram Chat ID</span>
            <input
              className="km-input"
              placeholder="chat.id，私聊是一串正数"
              value={form.telegramChatId}
              onChange={(e) => setForm((s) => ({ ...s, telegramChatId: e.target.value }))}
            />
            <span className="text-xs text-[var(--km-fg-muted)]">
              填 chat.id，不要填 update_id。本站会轮询这个机器人接收 /bind，不要再给它设置 Webhook。
            </span>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="km-btn" disabled={busy} onClick={() => void save()}>
            保存通知设置
          </button>
          <button className="km-btn km-btn-ghost" disabled={busy} onClick={() => void test()}>
            发送测试通知
          </button>
        </div>
        <p className="text-xs text-[var(--km-fg-muted)]">
          测试会按上面填的地址发一条示例（测试代理店 / demo@example.com / Plus / ¥150）。Telegram Token 留空则用已保存的。代理在自己的后台生成绑定码，对机器人发送 /bind。
        </p>
      </div>
      <AdminMailSettings />
      <AdminMailTemplates />
      <AdminFolioSettings />
      <AdminTelegramBindings />
    </div>
  );
}

type Storefront = Record<string, unknown>;
type Appearance = { list?: Storefront[]; siteTheme?: string; siteName?: string };

export function AdminAppearance() {
  const [storefronts, setStorefronts] = useState<Storefront[]>([]);
  const [siteTheme, setSiteTheme] = useState("snow");
  const [siteName, setSiteName] = useState("Kaimi");

  async function reload() {
    const data = await loadAdminSection<Appearance>("appearance");
    // 旧的内部发卡页已经下线，它那份文案不用再改。
    setStorefronts((data?.list || []).filter((sf) => String(sf.kind) !== "shop"));
    setSiteTheme(data?.siteTheme || "snow");
    setSiteName(data?.siteName || "Kaimi");
  }

  useEffect(() => {
    void reload();
  }, []);

  async function saveSite() {
    await postAdminAction({ action: "save_appearance", siteTheme, siteName });
    await reload();
    toast("整站外观已保存");
  }

  return (
    <div className="space-y-4">
      <div className="km-panel space-y-3">
        <div>
          <h3 className="font-semibold">整站外观</h3>
          <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
            站点名和主题会应用到全部前台页面。代理店铺可以各自选主题，不受这里影响。
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1 text-sm">
            <span>站点名</span>
            <input className="km-input" value={siteName} onChange={(e) => setSiteName(e.target.value)} placeholder="如 Kaimi" />
          </label>
          <label className="block space-y-1 text-sm">
            <span>主题</span>
            <KmSelect
              value={siteTheme}
              options={THEME_CHOICES.map((theme) => ({ value: theme.id, label: `${theme.label} / ${theme.hint}` }))}
              onChange={setSiteTheme}
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <button className="km-btn" onClick={() => void saveSite()}>
            保存整站设置
          </button>
        </div>
      </div>
      {storefronts.map((sf) => (
        <StorefrontCard
          key={String(sf.id)}
          sf={sf}
          onSave={async (next) => {
            await postAdminAction({
              action: "save_storefront",
              id: next.id,
              storefrontName: next.siteName,
              themeId: next.themeId,
              announcement: next.announcement,
              afterSales: next.afterSales,
              enabled: next.enabled,
            });
            await reload();
            toast("页面文案已保存");
          }}
        />
      ))}
    </div>
  );
}

function StorefrontCard({
  sf,
  onSave,
}: {
  sf: Storefront;
  onSave: (next: Record<string, unknown>) => Promise<void>;
}) {
  const [form, setForm] = useState({
    id: Number(sf.id),
    siteName: String(sf.siteName || ""),
    themeId: String(sf.themeId || "snow"),
    announcement: String(sf.announcement || ""),
    afterSales: String(sf.afterSales || ""),
    enabled: Boolean(sf.enabled ?? true),
  });

  const title = String(sf.kind) === "recharge" ? "兑换页文案" : "页面文案";

  return (
    <div className="km-panel space-y-3">
      <div>
        <p className="font-medium">{title}</p>
        <p className="mt-1 text-xs text-[var(--km-fg-muted)]">只改这一页的标题和说明，整站主题用上面保存。</p>
      </div>
      <label className="block space-y-1 text-sm">
        <span>页面标题</span>
        <input
          className="km-input"
          value={form.siteName}
          onChange={(e) => setForm((s) => ({ ...s, siteName: e.target.value }))}
          placeholder="页面标题"
        />
      </label>
      <label className="block space-y-1 text-sm">
        <span>公告</span>
        <textarea
          className="km-input min-h-20"
          value={form.announcement}
          onChange={(e) => setForm((s) => ({ ...s, announcement: e.target.value }))}
          placeholder="显示在页面标题下方"
        />
      </label>
      <label className="block space-y-1 text-sm">
        <span>页脚说明</span>
        <textarea
          className="km-input min-h-16"
          value={form.afterSales}
          onChange={(e) => setForm((s) => ({ ...s, afterSales: e.target.value }))}
          placeholder="售后或注意事项"
        />
      </label>
      <button className="km-btn" onClick={() => void onSave(form)}>
        保存文案
      </button>
    </div>
  );
}
