import { THEMES, type ThemeId } from "@kaimi/themes";

export const THEME_CHOICES: Array<{
  id: ThemeId;
  label: string;
  hint: string;
}> = [
  { id: "snow", label: "暖纸白", hint: "浅色，近黑按钮" },
  { id: "aurora", label: "极光", hint: "深色，近白按钮" },
  { id: "ink", label: "墨黑", hint: "纯黑，近白按钮" },
  { id: "sakura", label: "樱粉", hint: "浅藕粉，近黑按钮" },
];

export function themeLabel(id: string) {
  return THEME_CHOICES.find((item) => item.id === id)?.label || THEMES.find((item) => item.id === id)?.label || id;
}
