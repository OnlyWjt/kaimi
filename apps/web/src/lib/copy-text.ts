export async function copyText(text: string) {
  const value = String(text || "");
  if (!value) throw new Error("没有可复制的内容");
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      /* HTTP 或权限不足时走下面的兼容复制 */
    }
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "readonly");
  input.style.position = "fixed";
  input.style.top = "0";
  input.style.left = "-9999px";
  document.body.appendChild(input);
  input.focus();
  input.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(input);
  if (ok) return;
  window.prompt("当前页面不能自动复制，请手动复制", value);
  throw new Error("复制失败，请手动复制");
}
