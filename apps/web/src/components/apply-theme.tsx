"use client";

import { useLayoutEffect } from "react";

/**
 * Applies a page theme to <html> so body background and tokens follow the page, not only <main>.
 * 布局里的 <html data-theme> 永远是后台的整站主题，服务端改不了，所以代理页面靠这里纠正。
 * <main class="km-themed-page"> 也要一起改：整页背景吃的是 main 自己的 token，
 * 只改 <html> 的话，代理点色板预览时背景会卡在保存过的旧主题上。
 */
export function ApplyTheme({ themeId }: { themeId: string }) {
  useLayoutEffect(() => {
    const targets = [
      document.documentElement,
      ...document.querySelectorAll<HTMLElement>("main.km-themed-page"),
    ];
    const previous = targets.map(
      (node) => [node, node.getAttribute("data-theme")] as const,
    );
    for (const node of targets) node.setAttribute("data-theme", themeId);
    return () => {
      for (const [node, value] of previous) {
        if (value) node.setAttribute("data-theme", value);
        else node.removeAttribute("data-theme");
      }
    };
  }, [themeId]);
  return null;
}
