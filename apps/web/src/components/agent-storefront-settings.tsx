"use client";

import { useEffect, useState } from "react";
import { toast } from "@/components/toast";
import { readApiJson } from "@/lib/http-error";
import {
  CONTACT_TYPES,
  DEFAULT_SETTINGS,
  MAX_CONTACTS,
  MAX_STATS,
  PLATFORM_HERO,
  type ContactItem,
  type Lang,
  type LocalText,
  type StorefrontSettings,
} from "@/lib/agent-storefront-config";

const CONTACT_TYPE_LABEL: Record<ContactItem["type"], string> = {
  telegram: "Telegram",
  email: "邮箱",
  wechat: "微信",
  qq: "QQ",
  link: "网页链接",
};

const CONTACT_PLACEHOLDER: Record<ContactItem["type"], string> = {
  telegram: "@your_support",
  email: "help@example.com",
  wechat: "微信号或客服二维码说明",
  qq: "123456789",
  link: "https://example.com/support",
};

/** 双语输入：中文必填、英文留空时前台自动回退中文 */
function BilingualField({
  label,
  hint,
  value,
  onChange,
  multiline = false,
}: {
  label: string;
  hint?: string;
  value: LocalText;
  onChange: (next: LocalText) => void;
  multiline?: boolean;
}) {
  const Field = multiline ? "textarea" : "input";
  return (
    <div className="space-y-1.5">
      <span className="text-sm">{label}</span>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field
          className="km-input w-full"
          rows={multiline ? 3 : undefined}
          value={value.zh}
          placeholder="中文"
          onChange={(event: { target: { value: string } }) =>
            onChange({ ...value, zh: event.target.value })
          }
        />
        <Field
          className="km-input w-full"
          rows={multiline ? 3 : undefined}
          value={value.en}
          placeholder="English（留空则显示中文）"
          onChange={(event: { target: { value: string } }) =>
            onChange({ ...value, en: event.target.value })
          }
        />
      </div>
      {hint ? <p className="text-xs text-[var(--km-fg-muted)]">{hint}</p> : null}
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2.5 text-sm">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <span className="font-medium">{label}</span>
        {hint ? (
          <span className="mt-0.5 block text-xs text-[var(--km-fg-muted)]">{hint}</span>
        ) : null}
      </span>
    </label>
  );
}

type AssignedPlan = { planKey: string; name: string };

export function AgentStorefrontSettings() {
  const [settings, setSettings] = useState<StorefrontSettings>(DEFAULT_SETTINGS);
  const [shopName, setShopName] = useState("");
  const [plans, setPlans] = useState<AssignedPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const data = await readApiJson<{
          settings: StorefrontSettings;
          shopName?: string;
          plans?: AssignedPlan[];
        }>(await fetch("/api/agent/storefront", { cache: "no-store" }));
        setSettings(data.settings);
        setShopName(data.shopName || "");
        setPlans(data.plans ?? []);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "装修配置加载失败");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function patch(next: Partial<StorefrontSettings>) {
    setSettings((current) => ({ ...current, ...next }));
  }

  function toggleLanguage(lang: Lang, on: boolean) {
    const next = on
      ? Array.from(new Set([...settings.languages, lang]))
      : settings.languages.filter((item) => item !== lang);
    if (!next.length) return;
    patch({
      languages: next,
      defaultLang: next.includes(settings.defaultLang) ? settings.defaultLang : next[0],
    });
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      await readApiJson(
        await fetch("/api/agent/storefront", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...settings, shopName }),
        }),
      );
      toast("店铺装修已保存");
    } catch (reason) {
      const text = reason instanceof Error ? reason.message : "保存失败";
      setError(text);
      toast(text, "err");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <section className="km-panel">
        <p className="text-sm text-[var(--km-fg-muted)]">正在加载装修配置…</p>
      </section>
    );
  }

  return (
    <section className="km-panel space-y-6">
      <p className="text-sm text-[var(--km-fg-muted)]">
        留空的文案会自动用平台默认值，不会出现空白区域。
      </p>

      <div className="space-y-4">
        <h3 className="text-sm font-semibold">品牌</h3>
        <label className="block space-y-1.5">
          <span className="text-sm">店名</span>
          <input
            className="km-input max-w-md"
            maxLength={64}
            value={shopName}
            placeholder="显示在顶栏和页脚"
            onChange={(event) => setShopName(event.target.value)}
          />
          <p className="text-xs text-[var(--km-fg-muted)]">
            店铺头尾、版权行、兑换页标题都会用这个名字。
          </p>
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm">Logo 字母</span>
          <input
            className="km-input w-24"
            maxLength={2}
            value={settings.logoLetter}
            placeholder="留空取店名首字"
            onChange={(event) => patch({ logoLetter: event.target.value })}
          />
        </label>
        <BilingualField
          label="店铺标语"
          hint="显示在页脚品牌下方"
          value={settings.slogan}
          onChange={(slogan) => patch({ slogan })}
        />
      </div>

      <div className="space-y-4 border-t border-[var(--km-border)] pt-5">
        <h3 className="text-sm font-semibold">商品名称</h3>
        <p className="text-xs text-[var(--km-fg-muted)]">
          改的是店铺卡片上的商品名。留空则继续用平台套餐名。
        </p>
        {plans.length ? (
          plans.map((plan) => (
            <BilingualField
              key={plan.planKey}
              label={plan.name}
              hint={`平台名称：${plan.name}`}
              value={settings.productNames[plan.planKey] ?? { zh: "", en: "" }}
              onChange={(name) =>
                patch({
                  productNames: { ...settings.productNames, [plan.planKey]: name },
                })
              }
            />
          ))
        ) : (
          <p className="text-sm text-[var(--km-fg-muted)]">
            还没有可售套餐。先在「售价与优惠」里定价，再回来改名字。
          </p>
        )}
      </div>

      <div className="space-y-4 border-t border-[var(--km-border)] pt-5">
        <h3 className="text-sm font-semibold">公告条</h3>
        <Toggle
          label="显示顶部公告"
          hint="适合写活动、维护通知，不填内容则不显示"
          checked={settings.announcement.enabled}
          onChange={(enabled) =>
            patch({ announcement: { ...settings.announcement, enabled } })
          }
        />
        {settings.announcement.enabled ? (
          <BilingualField
            label="公告内容"
            value={settings.announcement.text}
            onChange={(text) => patch({ announcement: { ...settings.announcement, text } })}
          />
        ) : null}
      </div>

      <div className="space-y-4 border-t border-[var(--km-border)] pt-5">
        <h3 className="text-sm font-semibold">首屏</h3>
        <Toggle
          label="显示首屏介绍区"
          checked={settings.hero.enabled}
          onChange={(enabled) => patch({ hero: { ...settings.hero, enabled } })}
        />
        {settings.hero.enabled ? (
          <>
            <BilingualField
              label="小标签"
              hint={`留空显示：${PLATFORM_HERO.chip.zh}`}
              value={settings.hero.chip}
              onChange={(chip) => patch({ hero: { ...settings.hero, chip } })}
            />
            <BilingualField
              label="主标题"
              hint={`留空显示：${PLATFORM_HERO.title.zh}`}
              value={settings.hero.title}
              onChange={(title) => patch({ hero: { ...settings.hero, title } })}
            />
            <BilingualField
              label="副标题"
              multiline
              hint="一句话说清你卖什么、多久发货"
              value={settings.hero.sub}
              onChange={(sub) => patch({ hero: { ...settings.hero, sub } })}
            />
          </>
        ) : null}
        <Toggle
          label="显示商品搜索框"
          checked={settings.searchEnabled}
          onChange={(searchEnabled) => patch({ searchEnabled })}
        />
      </div>

      <div className="space-y-4 border-t border-[var(--km-border)] pt-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">数据展示卡</h3>
          <button
            type="button"
            className="km-btn km-btn-ghost"
            disabled={settings.stats.items.length >= MAX_STATS}
            onClick={() =>
              patch({
                stats: {
                  ...settings.stats,
                  items: [...settings.stats.items, { value: "", label: { zh: "", en: "" } }],
                },
              })
            }
          >
            添加一项
          </button>
        </div>
        <Toggle
          label="显示数据卡"
          hint={`最多 ${MAX_STATS} 个，例如「4.9 买家评分」`}
          checked={settings.stats.enabled}
          onChange={(enabled) => patch({ stats: { ...settings.stats, enabled } })}
        />
        {settings.stats.items.map((stat, index) => (
          <div key={index} className="space-y-2 rounded-xl border border-[var(--km-border)] p-3">
            <div className="flex items-center gap-2">
              <input
                className="km-input w-28"
                maxLength={16}
                value={stat.value}
                placeholder="4.9"
                onChange={(event) => {
                  const items = [...settings.stats.items];
                  items[index] = { ...stat, value: event.target.value };
                  patch({ stats: { ...settings.stats, items } });
                }}
              />
              <button
                type="button"
                className="km-btn km-btn-ghost ml-auto"
                onClick={() =>
                  patch({
                    stats: {
                      ...settings.stats,
                      items: settings.stats.items.filter((_, i) => i !== index),
                    },
                  })
                }
              >
                删除
              </button>
            </div>
            <BilingualField
              label="说明文字"
              value={stat.label}
              onChange={(label) => {
                const items = [...settings.stats.items];
                items[index] = { ...stat, label };
                patch({ stats: { ...settings.stats, items } });
              }}
            />
          </div>
        ))}
      </div>

      <div className="space-y-4 border-t border-[var(--km-border)] pt-5">
        <h3 className="text-sm font-semibold">邮箱查单</h3>
        <Toggle
          label="开放邮箱查单入口"
          hint="关掉后买家只能凭付款后拿到的订单链接找回卡密，一般建议保持开启"
          checked={settings.queryEnabled}
          onChange={(queryEnabled) => patch({ queryEnabled })}
        />
      </div>

      <div className="space-y-4 border-t border-[var(--km-border)] pt-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">联系客服</h3>
          <button
            type="button"
            className="km-btn km-btn-ghost"
            disabled={settings.contacts.length >= MAX_CONTACTS}
            onClick={() =>
              patch({
                contacts: [
                  ...settings.contacts,
                  { type: "telegram", label: { zh: "", en: "" }, value: "" },
                ],
              })
            }
          >
            添加一条
          </button>
        </div>
        <p className="text-xs text-[var(--km-fg-muted)]">
          显示在店铺页脚，最多 {MAX_CONTACTS} 条。买家发货异常时会找这里。
        </p>
        {settings.contacts.map((contact, index) => (
          <div key={index} className="space-y-2 rounded-xl border border-[var(--km-border)] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="km-input w-32"
                value={contact.type}
                onChange={(event) => {
                  const contacts = [...settings.contacts];
                  contacts[index] = {
                    ...contact,
                    type: event.target.value as ContactItem["type"],
                  };
                  patch({ contacts });
                }}
              >
                {CONTACT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {CONTACT_TYPE_LABEL[type]}
                  </option>
                ))}
              </select>
              <input
                className="km-input min-w-0 flex-1"
                value={contact.value}
                placeholder={CONTACT_PLACEHOLDER[contact.type]}
                onChange={(event) => {
                  const contacts = [...settings.contacts];
                  contacts[index] = { ...contact, value: event.target.value };
                  patch({ contacts });
                }}
              />
              <button
                type="button"
                className="km-btn km-btn-ghost"
                onClick={() =>
                  patch({ contacts: settings.contacts.filter((_, i) => i !== index) })
                }
              >
                删除
              </button>
            </div>
            <BilingualField
              label="显示名称"
              hint="留空按类型显示默认名称"
              value={contact.label}
              onChange={(label) => {
                const contacts = [...settings.contacts];
                contacts[index] = { ...contact, label };
                patch({ contacts });
              }}
            />
          </div>
        ))}
      </div>

      <div className="space-y-4 border-t border-[var(--km-border)] pt-5">
        <h3 className="text-sm font-semibold">语言</h3>
        <div className="flex flex-wrap gap-4">
          <Toggle
            label="中文"
            checked={settings.languages.includes("zh")}
            onChange={(on) => toggleLanguage("zh", on)}
          />
          <Toggle
            label="English"
            checked={settings.languages.includes("en")}
            onChange={(on) => toggleLanguage("en", on)}
          />
        </div>
        <label className="block space-y-1.5">
          <span className="text-sm">默认语言</span>
          <select
            className="km-input w-40"
            value={settings.defaultLang}
            onChange={(event) => patch({ defaultLang: event.target.value as Lang })}
          >
            {settings.languages.map((lang) => (
              <option key={lang} value={lang}>
                {lang === "zh" ? "中文" : "English"}
              </option>
            ))}
          </select>
        </label>
        <p className="text-xs text-[var(--km-fg-muted)]">
          只启用一种语言时，店铺不显示语言切换按钮。
        </p>
      </div>

      {error ? <p className="text-sm text-[var(--km-danger)]">{error}</p> : null}
      <button type="button" className="km-btn km-btn-primary" disabled={busy} onClick={() => void save()}>
        {busy ? "保存中…" : "保存装修配置"}
      </button>
    </section>
  );
}
