import { THEMES, type ThemeId } from "@kaimi/themes";

/**
 * 中文名和一句话说明。类型是 Record<ThemeId, …>，
 * 所以在 @kaimi/themes 里加了主题却忘了在这里补文案，会直接编译不过。
 */
const THEME_NAMES: Record<ThemeId, { label: string; hint: string }> = {
  snow: { label: "暖纸白", hint: "浅色，近黑按钮" },
  ocean: { label: "海盐蓝", hint: "冷调浅色，正蓝按钮" },
  citrus: { label: "柑橘橙", hint: "暖橙浅色，大圆角" },
  sakura: { label: "樱粉", hint: "浅藕粉，玫红按钮" },
  mono: { label: "硬边白", hint: "纯白直角，高对比" },
  aurora: { label: "极光", hint: "深蓝夜色，青色按钮" },
  forest: { label: "松林绿", hint: "墨绿暗色，草绿按钮" },
  grape: { label: "葡萄紫", hint: "深紫暗色，淡紫按钮" },
  ink: { label: "墨黑", hint: "纯黑单色，近白按钮" },
};

export const THEME_CHOICES: Array<{
  id: ThemeId;
  label: string;
  hint: string;
}> = THEMES.map((theme) => ({ id: theme.id, ...THEME_NAMES[theme.id] }));

export function themeLabel(id: string) {
  return THEME_CHOICES.find((item) => item.id === id)?.label || id;
}
