import { regionDisplay } from "@/lib/cardplatform/regions";

const TONE: Record<string, React.CSSProperties> = {
  PH: { background: "color-mix(in srgb, var(--km-fg-muted) 14%, transparent)" },
  US: { background: "color-mix(in srgb, #3b82f6 16%, transparent)" },
  CL: { background: "color-mix(in srgb, #f59e0b 18%, transparent)" },
};

/** 付款地区徽标。不用国旗 emoji，Windows 上渲染不一致。 */
export function RegionBadge({
  country,
  regionLabel = "",
  size = "sm",
  compact = false,
}: {
  country: string;
  regionLabel?: string;
  size?: "sm" | "md";
  compact?: boolean;
}) {
  const region = regionDisplay(country, regionLabel);
  return (
    <span
      title={region.zh}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: size === "md" ? "2px 8px" : "1px 6px",
        borderRadius: 999,
        fontSize: size === "md" ? 13 : 12,
        lineHeight: 1.5,
        whiteSpace: "nowrap",
        color: "var(--km-fg)",
        ...(TONE[region.code] || TONE.PH),
      }}
    >
      <b style={{ fontFamily: "ui-monospace, monospace", fontWeight: 650 }}>{region.code}</b>
      {compact ? null : <span>{region.zh}</span>}
    </span>
  );
}
