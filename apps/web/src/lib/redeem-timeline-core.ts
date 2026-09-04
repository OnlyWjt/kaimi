/**
 * 卡台 `GET /cdk/result` 返回体的解析。
 *
 * 上游把订单字段包在 `order` 里，也见过扁平和 `data` 包裹两种形状，所以逐层回落。
 * `events[]` 里的字段在两边仓库都没有正式类型，全部按可选处理：少一个字段、多一个
 * 没见过的字段，都不能让整条时间线炸掉。
 */

export type RedeemOrderSnapshot = {
  status: string;
  stage: string;
  message: string;
  accountEmail: string;
  cardLastFour: string;
};

export type RedeemTimelineEvent = {
  /** 去重键。同一单里唯一，轮询重复拿到同一条事件时必须算成同一条。 */
  key: string;
  step: string;
  category: string;
  message: string;
  at: string;
  seq: number;
};

export type RedeemResult = {
  order: RedeemOrderSnapshot;
  events: RedeemTimelineEvent[];
};

/** 卡台文档里的终态。`review` / `pending` 不在其中：那两个还要继续查。 */
export const UPSTREAM_TERMINAL_STATUSES = new Set([
  "completed",
  "declined",
  "failed_precharge",
  "cancelled",
  "failed",
]);

const UPSTREAM_FAILED_STATUSES = new Set([
  "declined",
  "failed_precharge",
  "cancelled",
  "failed",
]);

/** 粗粒度进度条的四段，文案在 status-labels 的 redeemStage 域里。 */
export const COARSE_STAGE_KEYS = ["accept", "card", "pay", "done"] as const;

export type CoarseStageKey = (typeof COARSE_STAGE_KEYS)[number];

/**
 * 一单最多留多少条时间线。
 *
 * 卡台自己的进度回调每单封顶 30 条，公开时间线是同源数据，正常远到不了这里。这个上限
 * 是防上游异常刷条目——轮询每 2 秒一次，没有硬顶就是无界增长。
 */
export const MAX_TIMELINE_EVENTS_PER_ORDER = 200;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function pick(source: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const found = str(source[key]);
    if (found) return found;
  }
  return "";
}

/** 订单字段所在的对象：`order` → `data.order` → `data` → 顶层。 */
export function resultOrderRecord(payload: unknown): Record<string, unknown> {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  for (const candidate of [root.order, data.order, root.data]) {
    const record = asRecord(candidate);
    if (Object.keys(record).length > 0) return record;
  }
  return root;
}

/** 兑换状态。顶层 `status` 只是回落，权威值在 `order.status`。 */
export function resultOrderStatus(payload: unknown) {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  return (
    pick(resultOrderRecord(payload), "status") ||
    pick(root, "status") ||
    pick(data, "status")
  ).toLowerCase();
}

function cardLastFour(order: Record<string, unknown>) {
  const last = pick(order, "card_last_four", "card_last4");
  if (/^\d{4}$/.test(last)) return last;
  const digits = pick(order, "card_number").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : "";
}

function rawEvents(payload: unknown): unknown[] {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  for (const candidate of [
    root.events,
    data.events,
    resultOrderRecord(payload).events,
  ]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function eventTime(raw: Record<string, unknown>) {
  return pick(raw, "created_at", "createdAt", "occurred_at", "at", "time");
}

/**
 * 事件去重键。
 *
 * 优先用上游自己的 id。没有就拼「步骤 + 时间 + 分类」——同一单里这三个字段一样的两条
 * 事件会被并成一条，代价可以接受：轮询每 2 秒重复拉同一批事件，宁可少一行也不能每
 * 轮都插一遍。三个字段全空时退化成下标，事件是追加的，下标在轮询之间是稳的。
 */
export function timelineEventKey(raw: unknown, index: number) {
  const record = asRecord(raw);
  const id = pick(record, "id", "event_id", "uuid");
  if (id) return `id:${id}`;
  const parts = [
    pick(record, "step", "step_key", "name"),
    eventTime(record),
    pick(record, "category", "level", "kind"),
  ];
  return parts.join("") ? `k:${parts.join("|")}` : `i:${index}`;
}

/** 卡台返回体 → 订单快照 + 按时间升序的时间线。 */
export function parseRedeemResult(payload: unknown): RedeemResult {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  const order = resultOrderRecord(payload);

  const events = rawEvents(payload)
    .map((raw, index) => {
      const record = asRecord(raw);
      return {
        key: timelineEventKey(raw, index),
        step: pick(record, "step", "step_key", "name").toLowerCase(),
        category: pick(record, "category", "level", "kind").toLowerCase(),
        // 只收 public_message。这条时间线买家也看得到，而只有 public_message 是上游
        // 保证脱敏过的；message / to_status 里出现过内部错误码和状态机名字。
        // 管理端要看全的，去调试面板读原始报文。
        message: pick(record, "public_message"),
        at: eventTime(record),
        seq: index,
      };
    })
    // 时间相同或缺失时保持上游给的顺序，别把没有时间戳的事件洗乱。
    .sort((a, b) => {
      const ta = Date.parse(a.at);
      const tb = Date.parse(b.at);
      if (Number.isNaN(ta) || Number.isNaN(tb) || ta === tb) return a.seq - b.seq;
      return ta - tb;
    })
    .map((event, index) => ({ ...event, seq: index }));

  // 同一批里键撞了说明上游确实给了无法区分的两条，保留先到的那条。
  const seen = new Set<string>();
  const unique = events.filter((event) => {
    if (seen.has(event.key)) return false;
    seen.add(event.key);
    return true;
  });

  return {
    order: {
      status: resultOrderStatus(payload),
      stage: pick(order, "stage") || pick(root, "stage") || pick(data, "stage"),
      message:
        pick(order, "message", "user_message") ||
        pick(root, "message", "user_message", "msg") ||
        pick(data, "message", "user_message"),
      accountEmail: (
        pick(order, "account_email", "email") || pick(root, "account_email")
      ).toLowerCase(),
      cardLastFour: cardLastFour(order),
    },
    events: unique,
  };
}

function stageHas(stage: string, ...needles: string[]) {
  return needles.some((needle) => stage.includes(needle));
}

/**
 * 粗粒度四段进度。上游没有这个字段，和同源项目一样由 status / stage / 已出现的步骤
 * 反推，所以只是个示意，不能当对账依据。
 */
export function coarseStageIndex(input: {
  status?: string;
  stage?: string;
  steps?: string[];
}) {
  const status = (input.status || "").trim().toLowerCase();
  const stage = (input.stage || "").trim().toLowerCase();
  const steps = input.steps || [];
  if (status === "completed") return 3;
  if (UPSTREAM_FAILED_STATUSES.has(status)) {
    // 失败停在走到过的最远一步，别让进度条缩回起点。
    if (stageHas(stage, "pay", "checkout", "subscription")) return 2;
    if (stageHas(stage, "card", "fund")) return 1;
    return 0;
  }
  if (stageHas(stage, "subscription", "paid", "invoice")) return 2;
  if (stageHas(stage, "dispatch", "payment", "checkout", "spend")) return 2;
  if (stageHas(stage, "card", "fund", "await")) return 1;
  if (steps.some((step) => ["payment", "subscription", "checkout"].includes(step))) {
    return 2;
  }
  return steps.length ? 1 : 0;
}

export function isUpstreamTerminal(status: string) {
  return UPSTREAM_TERMINAL_STATUSES.has((status || "").trim().toLowerCase());
}
