import { parseDbDate } from "@/lib/datetime";

/** 后台列表里的状态文案。和 lib/status-labels.ts 对齐，这里多了旧兑换单的几个状态。 */
export const STATUS_LABEL: Record<string, string> = {
  unused: "未使用",
  locked: "占用中",
  sold: "已售出",
  used: "已核销",
  disabled: "已禁用",
  pending: "排队中",
  processing: "处理中",
  success: "成功",
  failed: "失败",
  unknown: "未知",
  fulfilled: "已完成",
  paid: "已支付",
  unpaid: "未支付",
  refunded: "已退款",
  refunding: "退款中",
  pending_pay: "待支付",
  delivered: "已发卡",
  partially_delivered: "部分发卡",
  paid_undelivered: "已付未发",
  issuing: "发卡中",
  expired: "已过期",
  cancelled: "已取消",
  manual: "免支付",
  skipped: "已跳过",
  closed: "已关闭",
  chargeback: "已拒付",
};

const KIND_LABEL: Record<string, string> = {
  recharge: "兑换",
  shop: "发卡",
  code: "发卡",
  purchase: "进货",
};

export function kindLabel(kind: unknown) {
  const key = String(kind || "");
  if (key === "finished") return "成品号";
  if (key === "cdk") return "卡密";
  return KIND_LABEL[key] || key || "—";
}

export function progressLabel(kind: unknown, status: string) {
  if (kind === "finished") {
    if (status === "issuing") return "交付中";
    if (status === "delivered") return "已交付";
    if (status === "partially_delivered") return "部分交付";
    if (status === "paid_undelivered") return "待交付";
    if (status === "pending" || status === "unpaid" || status === "pending_pay") return "待支付";
  }
  return STATUS_LABEL[status] || status || "—";
}

export function formatWhen(value: unknown) {
  const raw = String(value || "");
  if (!raw) return "—";
  const d = parseDbDate(raw);
  if (!d) return raw;
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function statusTone(status: string) {
  const s = status.toLowerCase();
  if (["success", "fulfilled", "unused", "used", "paid", "ok", "delivered"].includes(s)) return "ok";
  if (["failed", "unknown", "disabled", "error", "paid_undelivered", "chargeback"].includes(s)) return "bad";
  if (["pending", "processing", "locked", "sold", "unpaid", "issuing", "partially_delivered", "refunding", "pending_pay"].includes(s)) return "wait";
  return "";
}

export function StatusBadge({ status }: { status: string }) {
  const tone = statusTone(status);
  return <span className={`km-badge ${tone ? `km-badge-${tone}` : ""}`}>{STATUS_LABEL[status] || status || "—"}</span>;
}

export function StatCard(props: { label: string; value: string; hint?: string }) {
  return (
    <div className="km-stat">
      <p className="text-xs text-[var(--km-fg-muted)]">{props.label}</p>
      <p className="km-stat-value">{props.value}</p>
      {props.hint ? <p className="mt-1 truncate text-xs text-[var(--km-fg-muted)]">{props.hint}</p> : null}
    </div>
  );
}
