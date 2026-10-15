"use client";

import { useEffect, useState } from "react";
import { RegionBadge } from "@/components/region-badge";
import { toast } from "@/components/toast";

type RegionInfo = {
  accountName: string;
  protocolSupported: boolean;
  syncedAt: string | null;
  regions: { country: string; currency: string }[];
  whitelist: string[];
};

/** 卡台支持哪些付款地区，以及哪些地区自动生成变体。 */
export function RegionPanel({ busy, onSynced }: { busy: string; onSynced: () => void }) {
  const [info, setInfo] = useState<RegionInfo | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  async function loadRegions() {
    const response = await fetch("/api/admin/cardplatform/regions", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) return;
    setInfo(data as RegionInfo);
    setChecked((data.whitelist || []) as string[]);
  }

  useEffect(() => {
    void loadRegions();
  }, []);

  async function save() {
    setSaving(true);
    try {
      const response = await fetch("/api/admin/cardplatform/regions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ whitelist: checked }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "地区设置保存失败");
      if (data.syncError) {
        toast(`地区设置已保存，但同步失败：${data.syncError}`, "err");
      } else {
        toast(`地区设置已保存${data.variantsCreated ? `，新生成 ${data.variantsCreated} 个地区版本` : ""}`);
      }
      await loadRegions();
      onSynced();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "地区设置保存失败", "err");
    } finally {
      setSaving(false);
    }
  }

  if (!info) return null;
  const syncedText = info.syncedAt
    ? new Date(info.syncedAt).toLocaleString("zh-CN", { hour12: false })
    : "还没同步过";
  return (
    <div className="rounded-lg border border-[var(--km-border)] p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <b>卡台付款地区</b>
        <span className="text-[var(--km-fg-muted)]">上次同步 {syncedText}</span>
      </div>
      {info.protocolSupported ? (
        <>
          <p className="mt-1 text-[var(--km-fg-muted)]">
            默认卡台账户：{info.accountName}。勾选的地区会给每个非续费、非点数套餐生成一个待定价版本，默认不上架。
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-1">
              <RegionBadge country="" /> 默认，始终可用
            </span>
            {info.regions.map((region) => (
              <label key={region.country} className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={checked.includes(region.country)}
                  onChange={(event) =>
                    setChecked((current) =>
                      event.target.checked
                        ? [...current, region.country]
                        : current.filter((item) => item !== region.country),
                    )
                  }
                />
                <RegionBadge country={region.country} />
                <span className="text-[var(--km-fg-muted)]">{region.currency}</span>
              </label>
            ))}
            {info.regions.length === 0 ? (
              <span className="text-[var(--km-fg-muted)]">卡台暂未提供付款地区（可能未升级）。</span>
            ) : null}
            <button
              type="button"
              className="km-btn km-btn-ghost km-btn-sm"
              disabled={saving || Boolean(busy)}
              onClick={() => void save()}
            >
              {saving ? "保存中…" : "保存地区设置"}
            </button>
          </div>
        </>
      ) : (
        <p className="mt-1 text-[var(--km-danger)]">
          默认卡台账户是 Avanfinity 协议，不支持付款地区。已有的地区版本全部自动停售。
        </p>
      )}
    </div>
  );
}
