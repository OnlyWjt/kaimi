"use client";

import { useEffect, useState } from "react";
import { toast } from "@/components/toast";
import { issuerChannelLabel } from "@/lib/cardplatform/issuer";
import { readApiJson } from "@/lib/http-error";

type Account = {
  id: number;
  name: string;
  enabled: boolean;
  isDefault: boolean;
};

type Product = {
  productCode: string;
  issuer: string;
  bin: string;
  scene: string;
  issuingArea: string;
  description: string;
  enabled: boolean;
  suspendedAt: string;
};

type Rule = {
  planKey: string;
  displayName: string;
  binPrefix: string;
  channel: string;
  enabled: boolean;
  online?: boolean;
};

type Policy = {
  enabled: boolean;
  noAutoCardSwitch: boolean;
  strictCardPreference: boolean;
  autoOpenWhenNoCard: boolean;
  maxNewAccountsPerCard: number;
  maxCardsPerTask: number;
  failCooldownHours: number;
  issuingArea: string;
  holderFirst: string;
  holderLast: string;
};

type HealthPolicy = {
  enabled: boolean;
  failThreshold: number;
  freezeOnBlock: boolean;
  requireKnownEmail: boolean;
};

type Block = {
  cardId: number;
  cardLastFour: string;
  reason: string;
  failCount: number;
  distinctEmails: number;
};

const emptyPolicy: Policy = {
  enabled: false,
  noAutoCardSwitch: true,
  strictCardPreference: true,
  autoOpenWhenNoCard: true,
  maxNewAccountsPerCard: 4,
  maxCardsPerTask: 3,
  failCooldownHours: 24,
  issuingArea: "United States",
  holderFirst: "GPT",
  holderLast: "Direct",
};

const emptyHealth: HealthPolicy = {
  enabled: true,
  failThreshold: 2,
  freezeOnBlock: false,
  requireKnownEmail: true,
};

function formatWhen(value?: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("zh-CN", { hour12: false });
}

function isOnline(product: Pick<Product, "enabled" | "suspendedAt">) {
  return product.enabled && !product.suspendedAt;
}

function moveToIndex<T>(list: T[], from: number, to: number) {
  if (from === to || from < 0 || from >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (!item) return list;
  next.splice(Math.max(0, Math.min(next.length, to)), 0, item);
  return next;
}

function RankField({
  index,
  total,
  onMove,
}: {
  index: number;
  total: number;
  onMove: (nextIndex: number) => void;
}) {
  const [draft, setDraft] = useState(String(index + 1));

  useEffect(() => {
    setDraft(String(index + 1));
  }, [index]);

  function commit() {
    const next = Number(draft.trim());
    if (!Number.isInteger(next) || next < 1) {
      setDraft(String(index + 1));
      return;
    }
    onMove(Math.min(total, next) - 1);
  }

  return (
    <label className="flex items-center gap-1">
      <span className="text-xs text-[var(--km-fg-muted)]">优先级</span>
      <input
        className="km-input w-14"
        inputMode="numeric"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
    </label>
  );
}

export function CardSelectionConfig() {
  const [busy, setBusy] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [showOffline, setShowOffline] = useState(true);
  const [rules, setRules] = useState<Rule[]>([]);
  const [lastSync, setLastSync] = useState("");
  const [policy, setPolicy] = useState<Policy>(emptyPolicy);
  const [resolvedPref, setResolvedPref] = useState("");
  const [health, setHealth] = useState<HealthPolicy>(emptyHealth);
  const [blocklist, setBlocklist] = useState<Block[]>([]);
  const [countDraft, setCountDraft] = useState({
    maxNewAccountsPerCard: String(emptyPolicy.maxNewAccountsPerCard),
    maxCardsPerTask: String(emptyPolicy.maxCardsPerTask),
    failCooldownHours: String(emptyPolicy.failCooldownHours),
    failThreshold: String(emptyHealth.failThreshold),
  });

  const selected = accounts.find((item) => item.id === selectedId) || null;
  const visibleProducts = showOffline
    ? products
    : products.filter((item) => isOnline(item));
  const onlineCount = products.filter((item) => isOnline(item)).length;

  function notice(text: string, kind: "ok" | "err" = "ok") {
    toast(text, kind);
  }

  async function run(name: string, work: () => Promise<void>) {
    setBusy(name);
    try {
      await work();
    } catch (error) {
      notice(error instanceof Error ? error.message : "操作失败", "err");
    } finally {
      setBusy("");
    }
  }

  async function loadAccounts() {
    const data = await readApiJson(
      await fetch("/api/admin/cardplatform/accounts", { cache: "no-store" }),
    );
    const list = (data.list || []) as Account[];
    setAccounts(list);
    setSelectedId((current) => {
      if (current && list.some((item) => item.id === current)) return current;
      return list.find((item) => item.isDefault)?.id ?? list[0]?.id ?? null;
    });
    return list;
  }

  async function loadSelected(id: number) {
    const [sel, pol, hlt] = await Promise.all([
      readApiJson(
        await fetch(`/api/admin/cardplatform/accounts/${id}/selection`, {
          cache: "no-store",
        }),
      ),
      readApiJson(
        await fetch(`/api/admin/cardplatform/accounts/${id}/policy`, {
          cache: "no-store",
        }),
      ),
      readApiJson(
        await fetch(`/api/admin/cardplatform/accounts/${id}/health`, {
          cache: "no-store",
        }),
      ),
    ]);
    setProducts(sel.products || []);
    setRules(
      (sel.rules || []).map((rule: Rule) => ({
        planKey: rule.planKey,
        displayName: rule.displayName,
        binPrefix: rule.binPrefix,
        channel: rule.channel,
        enabled: rule.enabled,
        online: rule.online,
      })),
    );
    setLastSync(sel.lastSync || "");
    if (pol.policy) {
      const nextPolicy = { ...emptyPolicy, ...pol.policy };
      setPolicy(nextPolicy);
      setCountDraft((current) => ({
        ...current,
        maxNewAccountsPerCard: String(nextPolicy.maxNewAccountsPerCard),
        maxCardsPerTask: String(nextPolicy.maxCardsPerTask),
        failCooldownHours: String(nextPolicy.failCooldownHours),
      }));
    }
    const pref = pol.resolvedPref || sel.resolvedPref;
    setResolvedPref(
      pref?.segmentKey
        ? `${pref.issuer || "one"} / ${pref.segmentKey}`
        : "未指定（按选卡优先级第一条）",
    );
    if (hlt.policy) {
      const nextHealth = { ...emptyHealth, ...hlt.policy };
      setHealth(nextHealth);
      setCountDraft((current) => ({
        ...current,
        failThreshold: String(nextHealth.failThreshold),
      }));
    }
    setBlocklist(hlt.blocklist || []);
  }

  useEffect(() => {
    void loadAccounts().catch((error) => {
      notice(error instanceof Error ? error.message : "加载失败", "err");
    });
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setProducts([]);
      setRules([]);
      setBlocklist([]);
      return;
    }
    void loadSelected(selectedId).catch((error) => {
      notice(error instanceof Error ? error.message : "读取选卡配置失败", "err");
    });
  }, [selectedId]);

  function addProduct(product: Product) {
    setRules((current) => {
      if (current.some((rule) => rule.planKey === product.productCode)) return current;
      return [
        ...current,
        {
          planKey: product.productCode,
          displayName: product.description || product.productCode,
          binPrefix: product.bin,
          channel: product.issuer,
          enabled: true,
          online: isOnline(product),
        },
      ];
    });
  }

  function parseCount(value: string, fallback: number) {
    const next = Number(value.trim());
    return Number.isInteger(next) && next >= 0 ? next : fallback;
  }

  return (
    <div className="space-y-4">
      <div className="km-panel space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold" style={{ fontFamily: "var(--font-sora)" }}>
              选卡配置
            </h2>
            <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
              产品、在线状态和选卡优先级按卡台账户独立保存；主台的产品码不会套到备台。
            </p>
          </div>
          <a href="/admin#integration" className="km-btn km-btn-ghost">
            去接入卡台
          </a>
        </div>
        {accounts.length === 0 ? (
          <p className="text-sm text-[var(--km-warning)]">
            还没有卡台账户，先到「接入卡台」添加主台。
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {accounts.map((account) => (
              <button
                key={account.id}
                className={`km-btn ${selectedId === account.id ? "" : "km-btn-ghost"}`}
                onClick={() => setSelectedId(account.id)}
              >
                {account.name}
                {account.isDefault ? " · 主" : " · 备"}
                {account.enabled ? "" : " · 已停用"}
              </button>
            ))}
          </div>
        )}
      </div>

      {selectedId ? (
        <>
          <div className="km-panel space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-semibold">产品在线状态</h3>
                <p className="text-sm text-[var(--km-fg-muted)]">
                  {selected?.name || "当前账户"}「可开卡产品」· 每 3 分钟同步 · 在线{" "}
                  {onlineCount} / 共 {products.length}
                  {lastSync ? ` · 上次 ${formatWhen(lastSync)}` : ""}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={showOffline}
                    onChange={(e) => setShowOffline(e.target.checked)}
                  />
                  显示已下线
                </label>
                <button
                  type="button"
                  className="km-btn km-btn-ghost"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void run("sync-products", async () => {
                      const data = await readApiJson(
                        await fetch(
                          `/api/admin/cardplatform/accounts/${selectedId}/sync-products`,
                          { method: "POST" },
                        ),
                      );
                      setProducts(data.products || []);
                      setLastSync(data.syncedAt || "");
                      notice(`已同步 ${data.count ?? 0} 个卡头`);
                    })
                  }
                >
                  {busy === "sync-products" ? "同步中…" : "立即同步"}
                </button>
              </div>
            </div>
            {products.length === 0 ? (
              <p className="text-sm text-[var(--km-fg-muted)]">
                暂无产品缓存。先在「接入卡台」配好 Key，再点立即同步。
              </p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {visibleProducts.map((product) => (
                  <div
                    key={product.productCode}
                    className="rounded-xl border border-[var(--km-border)] px-3 py-2 text-sm"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono">{product.productCode}</span>
                      <span
                        className={`km-badge ${
                          isOnline(product) ? "km-badge-ok" : "km-badge-wait"
                        }`}
                      >
                        {isOnline(product) ? "在线" : "已下线"}
                      </span>
                    </div>
                    <p className="mt-1 text-[var(--km-fg-muted)]">
                      {issuerChannelLabel(product.issuer)}
                    </p>
                    <p className="font-mono text-xs">
                      {product.bin || "—"}
                    </p>
                    <p className="text-xs text-[var(--km-fg-muted)]">
                      {product.issuingArea || "—"} · {product.scene || product.description || "—"}
                    </p>
                    <button
                      type="button"
                      className="km-btn km-btn-ghost mt-2 w-full"
                      disabled={rules.some((rule) => rule.planKey === product.productCode)}
                      onClick={() => addProduct(product)}
                    >
                      {rules.some((rule) => rule.planKey === product.productCode)
                        ? "已在优先级"
                        : "加入优先级"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="km-panel space-y-3">
            <div>
              <h3 className="font-semibold">
                {selected?.name || "当前账户"} · 自动选卡优先级
              </h3>
              <p className="text-sm text-[var(--km-fg-muted)]">
                顺序越靠前优先级越高；已下线或未启动的自动跳过。保存后会同步到该卡台
                gpt/claude/grok 规则。仅渠道 1/3/4（美卡）参与自动选卡。
              </p>
            </div>
            {rules.length === 0 ? (
              <p className="text-sm text-[var(--km-fg-muted)]">
                暂无规则，从下面产品加入。
              </p>
            ) : (
              <div className="space-y-2">
                {rules.map((rule, index) => (
                  <div
                    key={`${rule.planKey}-${index}`}
                    className="flex flex-wrap items-center gap-2 rounded-xl bg-[var(--km-bg-muted)] px-3 py-2 text-sm"
                  >
                    <RankField
                      index={index}
                      total={rules.length}
                      onMove={(nextIndex) =>
                        setRules((current) => moveToIndex(current, index, nextIndex))
                      }
                    />
                    <span className="font-mono">{rule.planKey}</span>
                    <span className="text-[var(--km-fg-muted)]">
                      {issuerChannelLabel(rule.channel)}
                    </span>
                    <span
                      className={`km-badge ${rule.online ? "km-badge-ok" : "km-badge-wait"}`}
                    >
                      {rule.online ? "在线" : "已下线"}
                    </span>
                    <label className="ml-auto flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={(e) =>
                          setRules((current) =>
                            current.map((item, i) =>
                              i === index ? { ...item, enabled: e.target.checked } : item,
                            ),
                          )
                        }
                      />
                      启用
                    </label>
                    <button
                      className="km-btn km-btn-ghost"
                      disabled={index === 0}
                      onClick={() =>
                        setRules((current) => {
                          const next = [...current];
                          [next[index - 1], next[index]] = [next[index], next[index - 1]];
                          return next;
                        })
                      }
                    >
                      上移
                    </button>
                    <button
                      className="km-btn km-btn-ghost"
                      disabled={index === rules.length - 1}
                      onClick={() =>
                        setRules((current) => {
                          const next = [...current];
                          [next[index + 1], next[index]] = [next[index], next[index + 1]];
                          return next;
                        })
                      }
                    >
                      下移
                    </button>
                    <button
                      className="km-btn km-btn-ghost"
                      onClick={() =>
                        setRules((current) => current.filter((_, i) => i !== index))
                      }
                    >
                      删除
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <select
                className="km-input max-w-xs"
                defaultValue=""
                onChange={(e) => {
                  const code = e.target.value;
                  const product = products.find((item) => item.productCode === code);
                  e.target.value = "";
                  if (product) addProduct(product);
                }}
              >
                <option value="">从产品加入优先级…</option>
                {products.map((product) => (
                  <option key={product.productCode} value={product.productCode}>
                    {product.productCode} / {issuerChannelLabel(product.issuer)}
                  </option>
                ))}
              </select>
              <button
                className="km-btn"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run("rules", async () => {
                    const data = await readApiJson(
                      await fetch(
                        `/api/admin/cardplatform/accounts/${selectedId}/selection`,
                        {
                          method: "PUT",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ rules }),
                        },
                      ),
                    );
                    setRules((data.rules || []).map((rule: Rule) => ({ ...rule })));
                    notice(
                      data.cardplatformOk === false
                        ? `本站已保存，卡台同步失败：${data.cardplatformErr}`
                        : "选卡优先级已保存并同步到卡台",
                      data.cardplatformOk === false ? "err" : "ok",
                    );
                  })
                }
              >
                保存选卡优先级
              </button>
            </div>
          </div>

          <div className="km-panel space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">本站可控策略</h3>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={policy.enabled}
                  onChange={(e) =>
                    setPolicy((s) => ({ ...s, enabled: e.target.checked }))
                  }
                />
                启用本站兑换策略
              </label>
            </div>
            <p className="text-sm text-[var(--km-fg-muted)]">
              启用后发码写入选卡偏好，兑换向卡台声明 no_auto_card_switch /
              strict_card_preference。
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block space-y-1 text-sm">
                <span>每卡新账号上限</span>
                <input
                  className="km-input"
                  inputMode="numeric"
                  value={countDraft.maxNewAccountsPerCard}
                  onChange={(e) =>
                    setCountDraft((s) => ({
                      ...s,
                      maxNewAccountsPerCard: e.target.value,
                    }))
                  }
                />
              </label>
              <label className="block space-y-1 text-sm">
                <span>单任务最多卡数</span>
                <input
                  className="km-input"
                  inputMode="numeric"
                  value={countDraft.maxCardsPerTask}
                  onChange={(e) =>
                    setCountDraft((s) => ({
                      ...s,
                      maxCardsPerTask: e.target.value,
                    }))
                  }
                />
              </label>
              <label className="block space-y-1 text-sm">
                <span>失败冷却（小时）</span>
                <input
                  className="km-input"
                  inputMode="numeric"
                  value={countDraft.failCooldownHours}
                  onChange={(e) =>
                    setCountDraft((s) => ({
                      ...s,
                      failCooldownHours: e.target.value,
                    }))
                  }
                />
              </label>
              <label className="block space-y-1 text-sm">
                <span>限定发卡地区</span>
                <input
                  className="km-input"
                  value={policy.issuingArea}
                  onChange={(e) =>
                    setPolicy((s) => ({ ...s, issuingArea: e.target.value }))
                  }
                />
              </label>
              <label className="block space-y-1 text-sm">
                <span>持卡人 First</span>
                <input
                  className="km-input"
                  value={policy.holderFirst}
                  onChange={(e) =>
                    setPolicy((s) => ({ ...s, holderFirst: e.target.value }))
                  }
                />
              </label>
              <label className="block space-y-1 text-sm">
                <span>持卡人 Last</span>
                <input
                  className="km-input"
                  value={policy.holderLast}
                  onChange={(e) =>
                    setPolicy((s) => ({ ...s, holderLast: e.target.value }))
                  }
                />
              </label>
              <div className="sm:col-span-2 text-sm text-[var(--km-fg-muted)]">
                当前发码偏好：{resolvedPref}
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={policy.noAutoCardSwitch}
                onChange={(e) =>
                  setPolicy((s) => ({ ...s, noAutoCardSwitch: e.target.checked }))
                }
              />
              失败后不自动换卡（发给卡台 no_auto_card_switch）
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={policy.autoOpenWhenNoCard}
                onChange={(e) =>
                  setPolicy((s) => ({ ...s, autoOpenWhenNoCard: e.target.checked }))
                }
              />
              无合格卡时自动开卡
            </label>
            <button
              className="km-btn"
              disabled={Boolean(busy)}
              onClick={() =>
                void run("policy", async () => {
                  const payload = {
                    ...policy,
                    maxNewAccountsPerCard: parseCount(
                      countDraft.maxNewAccountsPerCard,
                      emptyPolicy.maxNewAccountsPerCard,
                    ),
                    maxCardsPerTask: parseCount(
                      countDraft.maxCardsPerTask,
                      emptyPolicy.maxCardsPerTask,
                    ),
                    failCooldownHours: parseCount(
                      countDraft.failCooldownHours,
                      emptyPolicy.failCooldownHours,
                    ),
                  };
                  const data = await readApiJson(
                    await fetch(`/api/admin/cardplatform/accounts/${selectedId}/policy`, {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(payload),
                    }),
                  );
                  if (data.policy) {
                    const nextPolicy = { ...emptyPolicy, ...data.policy };
                    setPolicy(nextPolicy);
                    setCountDraft((current) => ({
                      ...current,
                      maxNewAccountsPerCard: String(nextPolicy.maxNewAccountsPerCard),
                      maxCardsPerTask: String(nextPolicy.maxCardsPerTask),
                      failCooldownHours: String(nextPolicy.failCooldownHours),
                    }));
                  }
                  const pref = data.resolvedPref;
                  setResolvedPref(
                    pref?.segmentKey
                      ? `${pref.issuer || "one"} / ${pref.segmentKey}`
                      : "未指定",
                  );
                  notice(
                    data.cardplatformOk === false
                      ? `策略已保存，卡台同步失败：${data.cardplatformErr}`
                      : "本站兑换策略已保存",
                    data.cardplatformOk === false ? "err" : "ok",
                  );
                })
              }
            >
              保存兑换策略
            </button>
          </div>

          <div className="km-panel space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">卡健康（失败归因）</h3>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={health.enabled}
                  onChange={(e) =>
                    setHealth((s) => ({ ...s, enabled: e.target.checked }))
                  }
                />
                启用
              </label>
            </div>
            <label className="block max-w-xs space-y-1 text-sm">
              <span>失败阈值</span>
              <input
                className="km-input"
                inputMode="numeric"
                value={countDraft.failThreshold}
                onChange={(e) =>
                  setCountDraft((s) => ({
                    ...s,
                    failThreshold: e.target.value,
                  }))
                }
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={health.freezeOnBlock}
                onChange={(e) =>
                  setHealth((s) => ({ ...s, freezeOnBlock: e.target.checked }))
                }
              />
              判定坏卡后冻卡台侧（本站默认只本地拉黑）
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={health.requireKnownEmail}
                onChange={(e) =>
                  setHealth((s) => ({ ...s, requireKnownEmail: e.target.checked }))
                }
              />
              邮箱问题不拉黑（推荐）
            </label>
            <button
              className="km-btn"
              disabled={Boolean(busy)}
              onClick={() =>
                void run("health", async () => {
                  const payload = {
                    ...health,
                    failThreshold: Math.max(
                      1,
                      parseCount(countDraft.failThreshold, emptyHealth.failThreshold),
                    ),
                  };
                  const data = await readApiJson(
                    await fetch(`/api/admin/cardplatform/accounts/${selectedId}/health`, {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(payload),
                    }),
                  );
                  if (data.policy) {
                    const nextHealth = { ...emptyHealth, ...data.policy };
                    setHealth(nextHealth);
                    setCountDraft((current) => ({
                      ...current,
                      failThreshold: String(nextHealth.failThreshold),
                    }));
                  }
                  setBlocklist(data.blocklist || []);
                  notice("卡健康策略已保存");
                })
              }
            >
              保存卡健康
            </button>
            <div>
              <p className="mb-1 text-sm text-[var(--km-fg-muted)]">当前拉黑</p>
              {blocklist.length === 0 ? (
                <p className="text-sm text-[var(--km-fg-muted)]">无</p>
              ) : (
                blocklist.map((item) => (
                  <div
                    key={item.cardId}
                    className="flex flex-wrap items-center gap-2 text-sm"
                  >
                    <span className="font-mono">
                      ****{item.cardLastFour || item.cardId}
                    </span>
                    <span className="text-[var(--km-fg-muted)]">
                      {item.reason} · 失败 {item.failCount} · 邮箱 {item.distinctEmails}
                    </span>
                    <button
                      className="km-btn km-btn-ghost"
                      onClick={() =>
                        void run("unblock", async () => {
                          const data = await readApiJson(
                            await fetch(
                              `/api/admin/cardplatform/accounts/${selectedId}/health/unblock`,
                              {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ cardId: item.cardId }),
                              },
                            ),
                          );
                          setBlocklist(data.blocklist || []);
                          notice("已解黑");
                        })
                      }
                    >
                      解黑
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      ) : null}

    </div>
  );
}
