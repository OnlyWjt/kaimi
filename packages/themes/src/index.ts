export type ThemeId = "aurora" | "snow" | "ink" | "sakura";

export type ThemeMeta = {
  id: ThemeId;
  label: string;
  description: string;
};

export const THEMES: ThemeMeta[] = [
  { id: "snow", label: "Snow", description: "暖纸白，近黑按钮" },
  { id: "aurora", label: "Aurora", description: "深色，近白按钮" },
  { id: "ink", label: "Ink", description: "纯黑，近白按钮" },
  { id: "sakura", label: "Sakura", description: "浅藕粉，近黑按钮" },
];

export const DEFAULT_THEME: ThemeId = "snow";

export function isThemeId(value: string): value is ThemeId {
  return THEMES.some((t) => t.id === value);
}
