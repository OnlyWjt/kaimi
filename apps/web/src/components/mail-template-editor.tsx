"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAskDialog } from "@/components/ask-dialog";
import { toast } from "@/components/toast";
import { contactTypeLabel } from "@/lib/agent-contact-core";
import type { ContactItem, ContactType } from "@/lib/agent-storefront-config";
import { formatLocalMonthDayTime } from "@/lib/datetime";
import {
  AFTER_SALES_INTRO_MAX,
  AFTER_SALES_SYSTEM,
  AFTER_SALES_TITLE_MAX,
  MAIL_BODY_MAX,
  MAIL_SUBJECT_MAX,
  MAIL_TEMPLATE_DEFS,
  MAIL_TEMPLATE_KEYS,
  MAIL_VAR_LABEL,
  afterSalesVisibleContacts,
  buildAfterSalesBlock,
  contactKey,
  renderMailTemplate,
  sampleMailContext,
  validateAfterSalesConfig,
  validateMailTemplate,
  type AfterSalesBlock,
  type AfterSalesConfig,
  type MailTemplate,
  type MailTemplateKey,
} from "@/lib/mail-template-core";
import "./mail-template-editor.css";

type Tab = MailTemplateKey | "after_sales";

type AgentSnapshot = {
  templates: Record<
    MailTemplateKey,
    { editable: boolean; platform: MailTemplate; mine: (MailTemplate & { updatedAt: string }) | null }
  >;
  afterSales: {
    config: AfterSalesConfig;
    customized: boolean;
    platform: { title: string; intro: string };
    shopContacts: ContactItem[];
  };
};

type AdminSnapshot = {
  templates: Record<
    MailTemplateKey,
    {
      editable: boolean;
      platform: MailTemplate | null;
      system: MailTemplate;
      customized: Array<{ agentId: number; name: string; username: string; updatedAt: string; template: MailTemplate }>;
    }
  >;
  afterSales: { title: string; intro: string; system: { title: string; intro: string } };
};

type Props =
  | { mode: "agent"; shopName: string; senderName: string }
  | { mode: "admin" };

const EXTRA_TYPES: ContactType[] = ["telegram", "wechat", "qq", "email", "link"];

/** 管理员示例店铺的售后区块：只为了预览好看，真实发信用各代理自己的。 */
function adminSampleAfterSales(text: { title: string; intro: string }): AfterSalesBlock {
  return {
    title: text.title || AFTER_SALES_SYSTEM.title,
    intro: text.intro,
    contacts: [
      { label: "微信", value: "example_shop", href: "" },
      { label: "Telegram", value: "@example_support", href: "https://t.me/example_support" },
    ],
  };
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "操作失败");
  return data as T;
}

/**
 * 买家邮件模板编辑器。代理：在「发给买家的邮件」卡片里，默认用平台模板，「自定义」后另存一份。
 * 管理员：改平台模板、「允许代理修改」、重置代理的模板。预览在浏览器里用和发信同一份渲染代码。
 */
export function MailTemplateEditor(props: Props) {
  const isAgent = props.mode === "agent";
  const api = isAgent ? "/api/agent/mail-templates" : "/api/admin/mail-templates";
  const { ask, dialog } = useAskDialog();
  const [agentData, setAgentData] = useState<AgentSnapshot | null>(null);
  const [adminData, setAdminData] = useState<AdminSnapshot | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("delivery");
  const [draft, setDraft] = useState<MailTemplate | null>(null);
  const [afterSales, setAfterSales] = useState<AfterSalesConfig | null>(null);
  const [view, setView] = useState<"html" | "text">("html");
  const [device, setDevice] = useState<"phone" | "desktop">("phone");
  const [viewing, setViewing] = useState<{ name: string; template: MailTemplate } | null>(null);
  const [busy, setBusy] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [addType, setAddType] = useState<ContactType>("telegram");
  const [addValue, setAddValue] = useState("");
  const [addError, setAddError] = useState("");
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);

  /** 服务端返回的最新数据。只有首次读取、或刚保存 / 恢复了售后联系时才覆盖售后联系的编辑内容。 */
  function apply(data: AgentSnapshot | AdminSnapshot, syncAfterSales = true) {
    if (isAgent) {
      const next = data as AgentSnapshot;
      setAgentData(next);
      if (syncAfterSales) setAfterSales(next.afterSales.config);
    } else {
      const next = data as AdminSnapshot;
      setAdminData(next);
      if (syncAfterSales) {
        setAfterSales({ title: next.afterSales.title, intro: next.afterSales.intro, hidden: [], extra: [] });
      }
    }
  }

  useEffect(() => {
    fetch(api, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "读取失败");
        apply(data);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "读取失败"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const loaded = isAgent ? agentData : adminData;

  /** 这封信现在生效的模板和来源。 */
  function effective(key: MailTemplateKey): { template: MailTemplate; layer: "mine" | "platform" | "system" } {
    if (isAgent && agentData) {
      const row = agentData.templates[key];
      if (row.editable && row.mine) return { template: row.mine, layer: "mine" };
      return { template: row.platform, layer: "platform" };
    }
    const row = adminData!.templates[key];
    return row.platform ? { template: row.platform, layer: "platform" } : { template: row.system, layer: "system" };
  }

  // 切换标签、或这封信生效的模板内容变了（保存、恢复、自定义）时，编辑框回到生效的模板。
  // 只翻「允许代理修改」开关时内容没变，不冲掉还没保存的修改。
  const effectiveSig = loaded && tab !== "after_sales" ? JSON.stringify(effective(tab)) : "";
  useEffect(() => {
    if (!effectiveSig || tab === "after_sales") {
      setDraft(null);
      return;
    }
    const { template } = effective(tab);
    setDraft({ subject: template.subject, body: template.body });
    setViewing(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, effectiveSig]);

  // 手机上标签栏横向滚动，把选中的滚进来
  useEffect(() => {
    const bar = tabsRef.current;
    const on = bar?.querySelector<HTMLElement>(".is-on");
    if (bar && on && bar.scrollWidth > bar.clientWidth) {
      bar.scrollLeft = Math.max(0, on.offsetLeft - (bar.clientWidth - on.offsetWidth) / 2);
    }
  }, [tab, loaded]);

  const shopContacts = useMemo(() => agentData?.afterSales.shopContacts ?? [], [agentData]);

  const afterSalesBlock = useMemo<AfterSalesBlock | null>(() => {
    if (!afterSales) return null;
    if (!isAgent) return adminSampleAfterSales(afterSales);
    return buildAfterSalesBlock(afterSales, shopContacts);
  }, [afterSales, isAgent, shopContacts]);

  const editable =
    tab === "after_sales" ||
    !isAgent ||
    Boolean(agentData && agentData.templates[tab].editable && agentData.templates[tab].mine);

  const check = useMemo(
    () => (draft && tab !== "after_sales" ? validateMailTemplate(tab, draft) : null),
    [draft, tab],
  );

  const afterSalesErrors = useMemo(
    () => (isAgent && afterSales ? validateAfterSalesConfig(afterSales, shopContacts) : []),
    [afterSales, isAgent, shopContacts],
  );

  const previewKey: MailTemplateKey = tab === "after_sales" ? "delivery" : tab;
  const previewTemplate: MailTemplate | null =
    viewing?.template ?? (tab === "after_sales" ? (loaded ? effective("delivery").template : null) : draft);

  const mail = useMemo(() => {
    if (!previewTemplate || !afterSalesBlock) return null;
    const shop = isAgent ? (props as { shopName: string }).shopName || "我的店铺" : "示例店铺";
    return renderMailTemplate(previewKey, previewTemplate, sampleMailContext({ shop, afterSales: afterSalesBlock }));
  }, [previewTemplate, afterSalesBlock, previewKey, isAgent, props]);

  async function run(body: Record<string, unknown>, done: string) {
    setBusy(true);
    try {
      const touchesAfterSales = body.action === "save_after_sales" || body.key === "after_sales";
      apply(await post(api, body), touchesAfterSales);
      toast(done);
      return true;
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "操作失败", "err");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function insert(before: string, after = "", placeholder = "") {
    const area = bodyRef.current;
    if (!area || !draft || !editable) return;
    const start = area.selectionStart;
    const end = area.selectionEnd;
    const selected = area.value.slice(start, end) || placeholder;
    const body = area.value.slice(0, start) + before + selected + after + area.value.slice(end);
    setDraft({ ...draft, body });
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  }

  function insertVar(name: string, block: boolean) {
    if (!block) return insert(`{{${name}}}`);
    const area = bodyRef.current;
    const before = area ? area.value.slice(0, area.selectionStart) : "";
    insert(`${before && !before.endsWith("\n") ? "\n" : ""}{{${name}}}\n`);
  }

  async function confirm(title: string, message: string) {
    return Boolean(await ask({ title, message, confirmLabel: "确定", danger: true }));
  }

  async function sendTest() {
    if (!previewTemplate || tab === "after_sales") return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testTo.trim())) {
      toast("先填收件邮箱", "err");
      return;
    }
    setBusy(true);
    try {
      await post(api, { action: "test", key: tab, template: previewTemplate, to: testTo.trim() });
      toast(`测试邮件已发到 ${testTo.trim()}`);
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "发送失败", "err");
    } finally {
      setBusy(false);
    }
  }

  function addExtra() {
    if (!afterSales) return;
    const value = addValue.trim();
    const next = { ...afterSales, extra: [...afterSales.extra, { type: addType, value }] };
    const errors = validateAfterSalesConfig(next, shopContacts).filter((item) => item.includes(value));
    if (!value) {
      setAddError("请填写联系方式");
      return;
    }
    if (errors.length) {
      setAddError(errors[0].replace(/^.*?：/, ""));
      return;
    }
    setAddError("");
    setAddValue("");
    setAfterSales(next);
  }

  if (error) return <p className="text-sm text-[var(--km-danger)]">邮件模板读取失败：{error}</p>;
  if (!loaded || !afterSales) return <p className="text-sm text-[var(--km-fg-muted)]">正在读取邮件模板…</p>;

  // —— 状态条 ——
  function statusBar() {
    if (tab === "after_sales") {
      return (
        <div className="mt-status">
          <span className="mt-badge is-mine">{isAgent ? "所有邮件共用" : "平台默认"}</span>
          <span className="grow">
            {isAgent
              ? "邮件里 {{after_sales}} 的位置显示这里的内容。标题、说明随便改，联系方式至少留一个微信、QQ 或 Telegram。"
              : "这里只定标题和说明的默认文字。联系方式由各代理在自己后台选，至少留一个微信、QQ 或 Telegram。"}
          </span>
          {isAgent && agentData?.afterSales.customized ? (
            <button
              type="button"
              className="km-btn km-btn-ghost km-btn-sm"
              disabled={busy}
              onClick={async () => {
                if (await confirm("恢复默认", "标题、说明恢复成平台默认，联系方式改回店铺装修里的全部。")) {
                  await run({ action: "reset", key: "after_sales" }, "已恢复默认");
                }
              }}
            >
              恢复默认
            </button>
          ) : null}
        </div>
      );
    }
    const def = MAIL_TEMPLATE_DEFS[tab];
    const eff = effective(tab);
    if (isAgent) {
      const row = agentData!.templates[tab];
      if (!row.editable) {
        return (
          <div className="mt-status">
            <span className="mt-badge is-lock">平台统一</span>
            <span className="grow">{def.hint} 平台统一了这封邮件的内容，不能修改。</span>
          </div>
        );
      }
      if (eff.layer === "mine") {
        return (
          <div className="mt-status">
            <span className="mt-badge is-mine">我的模板</span>
            <span className="grow">{def.hint}</span>
            <button
              type="button"
              className="km-btn km-btn-ghost km-btn-sm"
              disabled={busy}
              onClick={async () => {
                if (await confirm("恢复平台模板", "恢复成平台模板？你改的内容会删掉。")) {
                  await run({ action: "reset", key: tab }, "已恢复平台模板");
                }
              }}
            >
              恢复平台模板
            </button>
          </div>
        );
      }
      return (
        <div className="mt-status">
          <span className="mt-badge">平台模板</span>
          <span className="grow">{def.hint} 想改的话点「自定义」，会在平台模板的基础上另存一份。</span>
          <button
            type="button"
            className="km-btn km-btn-sm"
            disabled={busy}
            onClick={async () => {
              // 先把平台模板存成自己的一份，之后平台再改也不影响
              if (await run({ action: "save", key: tab, template: eff.template }, "已另存为你的模板，可以开始改了")) {
                requestAnimationFrame(() => bodyRef.current?.focus());
              }
            }}
          >
            自定义
          </button>
        </div>
      );
    }
    const row = adminData!.templates[tab];
    return (
      <div className="mt-status">
        <span className={`mt-badge${eff.layer === "platform" ? " is-mine" : ""}`}>
          {eff.layer === "platform" ? "平台模板" : "系统默认"}
        </span>
        <span className="grow">
          {def.hint}
          {row.customized.length ? ` ${row.customized.length} 个代理用的是自己的模板，这里改了不影响他们。` : ""}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={row.editable}
          className="mt-switch"
          disabled={busy}
          onClick={() =>
            void run(
              { action: "editable", key: tab, editable: !row.editable },
              row.editable ? "这封邮件改为平台统一，代理存的模板暂不生效" : "代理可以改这封邮件了",
            )
          }
        >
          <span className="track">
            <span className="knob" />
          </span>
          允许代理修改
        </button>
        {eff.layer === "platform" ? (
          <button
            type="button"
            className="km-btn km-btn-ghost km-btn-sm"
            disabled={busy}
            onClick={async () => {
              if (await confirm("恢复系统默认", "平台模板恢复成系统默认文案？没自定义的代理会跟着变。")) {
                await run({ action: "reset", key: tab }, "已恢复系统默认");
              }
            }}
          >
            恢复系统默认
          </button>
        ) : null}
      </div>
    );
  }

  // —— 编辑区 ——
  function templateEditor(key: MailTemplateKey) {
    if (!draft) return null;
    const def = MAIL_TEMPLATE_DEFS[key];
    const other = check?.errors.filter((item) => !item.startsWith("必须保留")) ?? [];
    return (
      <div className="mt-edit">
        <label className="mt-field">
          <span>标题</span>
          <input
            className="km-input"
            maxLength={MAIL_SUBJECT_MAX}
            value={draft.subject}
            readOnly={!editable}
            onChange={(event) => setDraft({ ...draft, subject: event.target.value })}
          />
        </label>
        <div className="mt-toolbar">
          <button type="button" className="mt-tool b" title="加粗" disabled={!editable} onClick={() => insert("**", "**", "要加粗的字")}>
            B
          </button>
          <button type="button" className="mt-tool" title="插入链接" disabled={!editable} onClick={() => insert("[", "](https://)", "链接文字")}>
            链接
          </button>
          <button type="button" className="mt-tool" title="分隔线" disabled={!editable} onClick={() => insert("\n---\n")}>
            分隔线
          </button>
          <span className="mt-tool-sep" />
          <span className="mt-tool-hint">空一行就是分段，网址会自动变成链接</span>
        </div>
        <div className="mt-chips">
          <span className="mt-chips-label">插入</span>
          {def.vars.map((name) => (
            <button
              key={name}
              type="button"
              className="mt-chip"
              title={`{{${name}}}`}
              disabled={!editable}
              onClick={() => insertVar(name, false)}
            >
              {MAIL_VAR_LABEL[name]}
            </button>
          ))}
        </div>
        <div className="mt-chips">
          <span className="mt-chips-label">区块</span>
          {def.blocks.map((name) => (
            <button
              key={name}
              type="button"
              className="mt-chip is-block"
              title={`{{${name}}}，单独占一行`}
              disabled={!editable}
              onClick={() => insertVar(name, true)}
            >
              {MAIL_VAR_LABEL[name]}
            </button>
          ))}
        </div>
        <textarea
          ref={bodyRef}
          className="km-input mt-body"
          spellCheck={false}
          maxLength={MAIL_BODY_MAX}
          value={draft.body}
          readOnly={!editable}
          onChange={(event) => setDraft({ ...draft, body: event.target.value })}
        />
        {check ? (
          <>
            <div className="mt-checks">
              <span>必须保留</span>
              {check.required.map((item) => (
                <span key={item.label} className={`mt-check ${item.ok ? "ok" : "bad"}`}>
                  {item.label}
                </span>
              ))}
            </div>
            {other.length ? (
              <ul className="mt-errors">
                {other.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
      </div>
    );
  }

  function afterSalesEditor() {
    if (!afterSales) return null;
    const set = (patch: Partial<AfterSalesConfig>) => setAfterSales({ ...afterSales, ...patch });
    if (!isAgent) {
      return (
        <div className="mt-edit">
          <label className="mt-field">
            <span>标题</span>
            <input className="km-input" maxLength={AFTER_SALES_TITLE_MAX} value={afterSales.title} onChange={(e) => set({ title: e.target.value })} />
          </label>
          <label className="mt-field mt-gap">
            <span>说明</span>
            <textarea className="km-input" rows={3} maxLength={AFTER_SALES_INTRO_MAX} value={afterSales.intro} onChange={(e) => set({ intro: e.target.value })} />
          </label>
          <p className="mt-note">代理没改过时用这里的文字；代理改了就用他自己的。</p>
        </div>
      );
    }
    const hidden = new Set(afterSales.hidden);
    const visible = afterSalesVisibleContacts(afterSales, shopContacts);
    return (
      <div className="mt-edit">
        <label className="mt-field">
          <span>标题</span>
          <input className="km-input" maxLength={AFTER_SALES_TITLE_MAX} value={afterSales.title} onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label className="mt-field mt-gap">
          <span>说明</span>
          <textarea className="km-input" rows={2} maxLength={AFTER_SALES_INTRO_MAX} value={afterSales.intro} onChange={(e) => set({ intro: e.target.value })} />
        </label>
        <div className="mt-field mt-gap">
          <span>联系方式</span>
          <div className="mt-contacts">
            {shopContacts.length === 0 && afterSales.extra.length === 0 ? (
              <p className="mt-contact mt-muted">店铺装修里还没有联系方式，可以在下面加一个只在邮件里用的。</p>
            ) : null}
            {shopContacts.map((contact) => {
              const k = contactKey(contact);
              return (
                <label key={k} className="mt-contact">
                  <input
                    type="checkbox"
                    checked={!hidden.has(k)}
                    onChange={(event) =>
                      set({
                        hidden: event.target.checked
                          ? afterSales.hidden.filter((item) => item !== k)
                          : [...afterSales.hidden, k],
                      })
                    }
                  />
                  <span className="type">{contact.label.zh.trim() || contactTypeLabel(contact.type)}</span>
                  <span className="val">{contact.value}</span>
                  <span className="src">店铺装修</span>
                </label>
              );
            })}
            {afterSales.extra.map((contact, index) => (
              <div key={`${contactKey(contact)}-${index}`} className="mt-contact">
                <input type="checkbox" checked disabled />
                <span className="type">{contactTypeLabel(contact.type)}</span>
                <span className="val">{contact.value}</span>
                <span className="src">只在邮件里用</span>
                <button type="button" className="del" onClick={() => set({ extra: afterSales.extra.filter((_, i) => i !== index) })}>
                  删除
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-add">
          <select className="km-input" value={addType} onChange={(event) => setAddType(event.target.value as ContactType)}>
            {EXTRA_TYPES.map((type) => (
              <option key={type} value={type}>
                {contactTypeLabel(type)}
              </option>
            ))}
          </select>
          <input
            className="km-input"
            placeholder="邮件专用的联系方式"
            value={addValue}
            onChange={(event) => setAddValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addExtra();
              }
            }}
          />
          <button type="button" className="km-btn km-btn-ghost" onClick={addExtra}>
            添加
          </button>
        </div>
        {addError ? <p className="mt-note bad">{addError}</p> : null}
        {afterSalesErrors.length ? (
          <ul className="mt-errors">
            {afterSalesErrors.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-note">
            邮件里会显示 {visible.length} 个联系方式。店铺装修里的联系方式改了，邮件里会跟着变。
          </p>
        )}
      </div>
    );
  }

  // —— 预览 ——
  function preview() {
    return (
      <div className="mt-preview">
        <div className="mt-prev-head">
          <span className="ttl">{tab === "after_sales" ? "预览 · 在发货邮件里的样子" : "预览 · 示例订单"}</span>
          <span className="mt-prev-switches">
            <span className="mt-seg">
              <button type="button" className={view === "html" ? "is-on" : ""} onClick={() => setView("html")}>
                邮件
              </button>
              <button type="button" className={view === "text" ? "is-on" : ""} onClick={() => setView("text")}>
                纯文本
              </button>
            </span>
            {view === "html" ? (
              <span className="mt-seg">
                <button type="button" className={device === "desktop" ? "is-on" : ""} onClick={() => setDevice("desktop")}>
                  电脑
                </button>
                <button type="button" className={device === "phone" ? "is-on" : ""} onClick={() => setDevice("phone")}>
                  手机
                </button>
              </span>
            ) : null}
          </span>
        </div>
        {viewing ? (
          <div className="mt-viewing">
            <span>正在看「{viewing.name}」的模板</span>
            <button type="button" className="mt-link" onClick={() => setViewing(null)}>
              回到平台模板
            </button>
          </div>
        ) : null}
        {mail ? (
          <>
            <div className="mt-prev-meta">
              <div>
                <b>标题</b>
                {mail.subject}
              </div>
              {isAgent && (props as { senderName: string }).senderName.trim() ? (
                <div>
                  <b>发件人</b>
                  {(props as { senderName: string }).senderName.trim()}
                </div>
              ) : null}
            </div>
            {view === "text" ? <pre className="mt-prev-text">{mail.text}</pre> : <MailFrame html={mail.html} device={device} />}
          </>
        ) : null}
      </div>
    );
  }

  function actions() {
    if (tab === "after_sales") {
      return (
        <div className="mt-actions">
          <button
            type="button"
            className="km-btn"
            disabled={busy || afterSalesErrors.length > 0}
            onClick={() =>
              void (isAgent
                ? run({ action: "save_after_sales", config: afterSales }, "售后联系已保存")
                : run({ action: "save_after_sales", title: afterSales!.title, intro: afterSales!.intro }, "默认文字已保存"))
            }
          >
            {isAgent ? "保存售后联系" : "保存默认文字"}
          </button>
        </div>
      );
    }
    const canSave = editable && Boolean(check) && check!.errors.length === 0;
    return (
      <div className="mt-actions">
        {editable ? (
          <button
            type="button"
            className="km-btn"
            disabled={busy || !canSave}
            onClick={() =>
              void run(
                { action: "save", key: tab, template: draft },
                isAgent ? "已保存，之后的邮件用你的模板" : "平台模板已保存",
              )
            }
          >
            {isAgent ? "保存邮件模板" : "保存平台模板"}
          </button>
        ) : null}
        <span className="gap" />
        <span className="mt-test">
          <input
            className="km-input"
            type="email"
            placeholder="收件邮箱"
            value={testTo}
            onChange={(event) => setTestTo(event.target.value)}
          />
          <button type="button" className="km-btn km-btn-ghost" disabled={busy} onClick={() => void sendTest()}>
            发测试邮件
          </button>
        </span>
      </div>
    );
  }

  function customizedAgents() {
    if (isAgent || tab === "after_sales") return null;
    const list = adminData!.templates[tab].customized;
    return (
      <div className="mt-agents">
        <h4>
          用自己模板的代理 <span className="mt-muted">{list.length}</span>
        </h4>
        {list.length ? (
          list.map((row) => (
            <div key={row.agentId} className="mt-agent-row">
              <span className="name">
                {row.name}
                {row.username ? <span className="mt-muted"> · {row.username}</span> : null}
              </span>
              <span className="when">改于 {formatLocalMonthDayTime(row.updatedAt)}</span>
              <button type="button" className="mt-link" onClick={() => setViewing({ name: row.name, template: row.template })}>
                查看
              </button>
              <button
                type="button"
                className="mt-link danger"
                disabled={busy}
                onClick={async () => {
                  if (await confirm("重置代理模板", `把「${row.name}」的这封邮件恢复成平台模板？他自己写的内容会删掉。`)) {
                    await run({ action: "reset_agent", agentId: row.agentId, key: tab }, `已重置，${row.name} 改用平台模板`);
                  }
                }}
              >
                重置
              </button>
            </div>
          ))
        ) : (
          <p className="mt-note">还没有代理改过这封邮件。</p>
        )}
      </div>
    );
  }

  const tabs: Tab[] = [...MAIL_TEMPLATE_KEYS, "after_sales"];
  return (
    <div className="mt-root">
      {dialog}
      <div ref={tabsRef} className="mt-tabs" role="tablist">
        {tabs.map((key) => {
          const mine = isAgent && key !== "after_sales" && agentData!.templates[key].editable && agentData!.templates[key].mine;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={`mt-tab${tab === key ? " is-on" : ""}`}
              onClick={() => setTab(key)}
            >
              {key === "after_sales" ? "售后联系" : MAIL_TEMPLATE_DEFS[key].label}
              {mine ? <span className="dot" title="用的是我的模板" /> : null}
            </button>
          );
        })}
      </div>
      {statusBar()}
      <div className="mt-work">
        <div>{tab === "after_sales" ? afterSalesEditor() : templateEditor(tab)}</div>
        <div>{preview()}</div>
      </div>
      {actions()}
      {customizedAgents()}
    </div>
  );
}

/**
 * 邮件预览。沙箱 iframe（不跑脚本）。电脑按 640px 排好再等比缩进预览栏，手机 375px 原样。
 */
function MailFrame({ html, device }: { html: string; device: "phone" | "desktop" }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [layout, setLayout] = useState({ height: 320, scale: 1, left: 0 });
  const width = device === "phone" ? 375 : 640;

  function measure() {
    const box = boxRef.current;
    const frame = frameRef.current;
    if (!box || !frame) return;
    let height = 320;
    try {
      height = Math.max(240, frame.contentDocument?.documentElement.scrollHeight || 320);
    } catch {
      /* 跨域读不到高度时用默认值 */
    }
    const avail = box.clientWidth - (device === "phone" ? 16 : 0);
    const scale = Math.min(1, avail / width);
    const left = device === "phone" ? Math.max(8, (box.clientWidth - width * scale) / 2) : 0;
    setLayout({ height, scale, left });
  }

  useEffect(() => {
    const observer = new ResizeObserver(() => measure());
    if (boxRef.current) observer.observe(boxRef.current);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device]);

  return (
    <div
      ref={boxRef}
      className={`mt-prev-body${device === "phone" ? " is-phone" : ""}`}
      style={{ height: layout.height * layout.scale + (device === "phone" ? 28 : 0) }}
    >
      <iframe
        ref={frameRef}
        title="邮件预览"
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={html}
        onLoad={measure}
        style={{
          width,
          height: layout.height,
          transform: layout.scale < 1 ? `scale(${layout.scale})` : undefined,
          transformOrigin: "top left",
          marginLeft: layout.left,
        }}
      />
    </div>
  );
}
