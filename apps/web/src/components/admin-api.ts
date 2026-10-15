"use client";

import { toast } from "@/components/toast";

/** 会话过期时广播，后台外壳收到后切回登录页。 */
export const ADMIN_UNAUTHORIZED_EVENT = "kaimi:admin-unauthorized";

/** 读 /api/admin?section=…（订单走 /api/admin/orders）。401 时广播并返回 null。 */
export async function loadAdminSection<T = Record<string, unknown>>(section: string, query = ""): Promise<T | null> {
  const qs = query.replace(/^&/, "");
  const url =
    section === "orders"
      ? `/api/admin/orders${qs ? `?${qs}` : ""}`
      : `/api/admin?section=${encodeURIComponent(section)}${qs ? `&${qs}` : ""}`;
  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 401) {
    window.dispatchEvent(new Event(ADMIN_UNAUTHORIZED_EVENT));
    return null;
  }
  return (await res.json().catch(() => null)) as T | null;
}

/** POST /api/admin 的 action，结果用 toast 提示。失败也返回响应体，调用方自己看 ok。 */
export async function postAdminAction(payload: Record<string, unknown>) {
  const res = await fetch("/api/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) window.dispatchEvent(new Event(ADMIN_UNAUTHORIZED_EVENT));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    toast(data.error || data.message || "操作失败", "err");
    return data;
  }
  toast(data.message || "已完成");
  return data;
}
