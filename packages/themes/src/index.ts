export type ThemeId =
  | "aurora"
  | "snow"
  | "ink"
  | "sakura"
  | "ocean"
  | "forest"
  | "citrus"
  | "mono"
  | "grape";

export type ThemeMeta = {
  id: ThemeId;
  label: string;
  description: string;
};

export const THEMES: ThemeMeta[] = [
  { id: "snow", label: "Snow", description: "暖纸白，近黑按钮" },
  { id: "ocean", label: "Ocean", description: "冷调浅蓝，正蓝按钮" },
  { id: "citrus", label: "Citrus", description: "暖橙浅色，大圆角" },
  { id: "sakura", label: "Sakura", description: "浅藕粉，玫红按钮" },
  { id: "mono", label: "Mono", description: "纯白直角，高对比" },
  { id: "aurora", label: "Aurora", description: "深蓝夜色，极光青按钮" },
  { id: "forest", label: "Forest", description: "墨绿暗色，草绿按钮" },
  { id: "grape", label: "Grape", description: "深紫暗色，淡紫按钮" },
  { id: "ink", label: "Ink", description: "纯黑单色，近白按钮" },
];

export const DEFAULT_THEME: ThemeId = "snow";

export function isThemeId(value: string): value is ThemeId {
  return THEMES.some((t) => t.id === value);
}
