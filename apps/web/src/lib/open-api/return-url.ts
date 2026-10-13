/**
 * 代客下单时，买家付完款跳回代理自己的站。
 *
 * 只有持代理 Key 的服务端才能传这个地址，所以不做域名白名单；
 * 但必须是 https、不能带账号密码，避免把买家带到明文或钓鱼形式的链接上。
 * 地址里可以写 {order_no}，建单后换成真实单号。
 */

export const RETURN_URL_ORDER_PLACEHOLDER = "{order_no}";
const MAX_RETURN_URL_LENGTH = 500;

export function checkReturnUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const value = raw.trim();
  if (!value) return { ok: false, error: "return_url 不能为空" };
  if (value.length > MAX_RETURN_URL_LENGTH) {
    return { ok: false, error: `return_url 不能超过 ${MAX_RETURN_URL_LENGTH} 个字符` };
  }
  let parsed: URL;
  try {
    parsed = new URL(value.replaceAll(RETURN_URL_ORDER_PLACEHOLDER, "KS0"));
  } catch {
    return { ok: false, error: "return_url 不是合法地址" };
  }
  if (parsed.protocol !== "https:") return { ok: false, error: "return_url 必须是 https 地址" };
  if (parsed.username || parsed.password) {
    return { ok: false, error: "return_url 不能带账号密码" };
  }
  return { ok: true, url: value };
}

/** 把占位符换成单号。单号只有字母数字，不需要再编码。 */
export function buildReturnUrl(template: string, orderNo: string) {
  return template.replaceAll(RETURN_URL_ORDER_PLACEHOLDER, encodeURIComponent(orderNo));
}
