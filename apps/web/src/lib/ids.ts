import { customAlphabet } from "nanoid";

const nano = customAlphabet("23456789ABCDEFGHJKLMNPQRSTUVWXYZ", 10);

export function newOrderNo(prefix = "KM") {
  const d = new Date();
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
    String(d.getHours()).padStart(2, "0"),
    String(d.getMinutes()).padStart(2, "0"),
  ].join("");
  return `${prefix}${stamp}${nano()}`;
}

export function newIdempotencyKey() {
  return crypto.randomUUID();
}
