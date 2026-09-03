"use client";

import { useLayoutEffect } from "react";

/** Applies a page theme to <html> so body background and tokens follow the page, not only <main>. */
export function ApplyTheme({ themeId }: { themeId: string }) {
  useLayoutEffect(() => {
    const html = document.documentElement;
    const previous = html.getAttribute("data-theme");
    html.setAttribute("data-theme", themeId);
    return () => {
      if (previous) html.setAttribute("data-theme", previous);
      else html.removeAttribute("data-theme");
    };
  }, [themeId]);
  return null;
}
