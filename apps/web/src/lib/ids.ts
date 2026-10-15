import { customAlphabet } from "nanoid";

const nano = customAlphabet("23456789ABCDEFGHJKLMNPQRSTUVWXYZ", 10);

/**
 * 单号里的时间段按北京时间写。容器默认是 UTC，按本地时间取的话，
 * 北京时间早上 8 点前下的单日期会是前一天，客服对着付款记录找单时对不上。
 */
export function newOrderNo(prefix = "KM", now = new Date()) {
  const d = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const stamp = [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
    String(d.getUTCHours()).padStart(2, "0"),
    String(d.getUTCMinutes()).padStart(2, "0"),
  ].join("");
  return `${prefix}${stamp}${nano()}`;
}

export function newIdempotencyKey() {
  return crypto.randomUUID();
}
