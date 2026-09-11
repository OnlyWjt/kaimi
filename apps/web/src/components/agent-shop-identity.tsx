"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { ApplyTheme } from "@/components/apply-theme";
import { toast } from "@/components/toast";
import { readApiJson } from "@/lib/http-error";
import { THEME_CHOICES } from "@/lib/themes";
import type { ThemeId } from "@kaimi/themes";

export function AgentShopIdentity({
  initialSlug,
  initialThemeId,
}: {
  initialSlug: string;
  initialThemeId: ThemeId;
}) {
  const router = useRouter();
  const [slug, setSlug] = useState(initialSlug);
  const [savedSlug, setSavedSlug] = useState(initialSlug);
  const [themeId, setThemeId] = useState<ThemeId>(initialThemeId);
  const [busy, setBusy] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const data = await readApiJson<{ slug: string; themeId?: ThemeId }>(
        await fetch("/api/agent/profile", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, themeId }),
        }),
      );
      setSlug(data.slug);
      setSavedSlug(data.slug);
      setThemeId(data.themeId || themeId);
      toast("店铺外观与链接已保存");
      router.refresh();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "保存失败", "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void save(event)} className="km-panel space-y-4">
      <ApplyTheme themeId={themeId} />
      <div>
        <h2 className="text-lg font-semibold">外观和链接</h2>
        <p className="mt-1 text-sm text-[var(--km-fg-muted)]">
          点选主题可立即预览。记得保存，店铺页才会记住。改 slug 后，旧链接会跳到新链接。
        </p>
      </div>
      <div className="space-y-2">
        <span className="text-sm">店铺主题</span>
        <div className="km-theme-grid">
          {THEME_CHOICES.map((theme) => (
            <button
              key={theme.id}
              type="button"
              data-theme={theme.id}
              className="km-theme-swatch"
              aria-pressed={themeId === theme.id}
              onClick={() => setThemeId(theme.id)}
            >
              <span className="flex items-center gap-2 font-medium">
                <span className="km-theme-dot" aria-hidden />
                {theme.label}
              </span>
              <span className="mt-1 block text-xs text-[var(--km-fg-muted)]">{theme.hint}</span>
            </button>
          ))}
        </div>
      </div>
      <label className="block space-y-2">
        <span className="text-sm">店铺 slug</span>
        <input
          className="km-input w-full max-w-md"
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          minLength={3}
          maxLength={32}
          required
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <a className="break-all text-sm underline" href={`/s/${savedSlug}`} target="_blank" rel="noreferrer">
          /s/{savedSlug}
        </a>
        <button className="km-btn km-btn-primary" disabled={busy}>
          {busy ? "保存中…" : "保存外观与链接"}
        </button>
      </div>
    </form>
  );
}
