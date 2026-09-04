import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { orderTimelineEvents, orderUpstreamSnapshots } from "@/db/schema";
import {
  MAX_TIMELINE_EVENTS_PER_ORDER,
  parseRedeemResult,
  type RedeemOrderSnapshot,
  type RedeemTimelineEvent,
} from "@/lib/redeem-timeline-core";

/** 原始报文只是排查用的，超过这个长度截断，别让一条异常返回把库撑起来。 */
const MAX_PAYLOAD_CHARS = 20_000;

export type StoredTimelineEvent = {
  step: string;
  category: string;
  message: string;
  at: string;
};

/**
 * 把一次卡台返回落库。
 *
 * 每 2~3 秒轮一次、批量时一轮 20 单，所以这里必须便宜：先读一次已有的去重键，只插
 * 真正新增的那几条。绝大多数轮次一条都不插。
 */
export async function recordUpstreamResult(
  orderId: number,
  payload: Record<string, unknown>,
) {
  const parsed = parseRedeemResult(payload);
  const now = new Date().toISOString();

  let serialized = "";
  try {
    serialized = JSON.stringify(payload) ?? "";
  } catch {
    // 循环引用之类的怪东西不值得为它中断轮询，丢掉原始报文即可。
    serialized = "";
  }

  await db
    .insert(orderUpstreamSnapshots)
    .values({
      orderId,
      status: parsed.order.status,
      stage: parsed.order.stage,
      message: parsed.order.message,
      accountEmail: parsed.order.accountEmail,
      cardLastFour: parsed.order.cardLastFour,
      payloadJson: serialized.slice(0, MAX_PAYLOAD_CHARS),
      fetchedAt: now,
    })
    .onConflictDoUpdate({
      target: orderUpstreamSnapshots.orderId,
      set: {
        status: parsed.order.status,
        stage: parsed.order.stage,
        message: parsed.order.message,
        // 账号和卡尾号是开卡之后才补上的，别让后来的空值把已经拿到的抹掉。
        ...(parsed.order.accountEmail
          ? { accountEmail: parsed.order.accountEmail }
          : {}),
        ...(parsed.order.cardLastFour
          ? { cardLastFour: parsed.order.cardLastFour }
          : {}),
        payloadJson: serialized.slice(0, MAX_PAYLOAD_CHARS),
        fetchedAt: now,
      },
    });

  if (!parsed.events.length) return parsed;

  const existing = await db
    .select({ eventKey: orderTimelineEvents.eventKey })
    .from(orderTimelineEvents)
    .where(eq(orderTimelineEvents.orderId, orderId));
  const known = new Set(existing.map((row) => row.eventKey));
  const room = MAX_TIMELINE_EVENTS_PER_ORDER - known.size;
  if (room <= 0) return parsed;

  const fresh = parsed.events
    .filter((event) => !known.has(event.key))
    .slice(0, room);
  if (!fresh.length) return parsed;

  await db
    .insert(orderTimelineEvents)
    .values(
      fresh.map((event) => ({
        orderId,
        eventKey: event.key,
        step: event.step,
        category: event.category,
        message: event.message,
        occurredAt: event.at,
        seq: event.seq,
        createdAt: now,
      })),
    )
    // 同一单被两条轮询同时写到时靠唯一索引挡住，重复的那次什么都不做。
    .onConflictDoNothing();

  return parsed;
}

export async function getOrderTimeline(
  orderId: number,
): Promise<StoredTimelineEvent[]> {
  const rows = await db
    .select()
    .from(orderTimelineEvents)
    .where(eq(orderTimelineEvents.orderId, orderId))
    .orderBy(asc(orderTimelineEvents.seq), asc(orderTimelineEvents.id))
    .limit(MAX_TIMELINE_EVENTS_PER_ORDER);
  return rows.map((row) => ({
    step: row.step,
    category: row.category,
    message: row.message,
    at: row.occurredAt || row.createdAt,
  }));
}

export async function getOrderTimelines(orderIds: number[]) {
  const out = new Map<number, StoredTimelineEvent[]>();
  if (!orderIds.length) return out;
  const rows = await db
    .select()
    .from(orderTimelineEvents)
    .where(inArray(orderTimelineEvents.orderId, orderIds))
    .orderBy(asc(orderTimelineEvents.seq), asc(orderTimelineEvents.id));
  for (const row of rows) {
    const list = out.get(row.orderId) || [];
    if (list.length >= MAX_TIMELINE_EVENTS_PER_ORDER) continue;
    list.push({
      step: row.step,
      category: row.category,
      message: row.message,
      at: row.occurredAt || row.createdAt,
    });
    out.set(row.orderId, list);
  }
  return out;
}

export type UpstreamSnapshot = RedeemOrderSnapshot & {
  fetchedAt: string;
  /** 原始报文，仅管理员接口会带上。 */
  payloadJson: string;
};

export async function getUpstreamSnapshot(
  orderId: number,
): Promise<UpstreamSnapshot | null> {
  const row = await db.query.orderUpstreamSnapshots.findFirst({
    where: eq(orderUpstreamSnapshots.orderId, orderId),
  });
  if (!row) return null;
  return {
    status: row.status,
    stage: row.stage,
    message: row.message,
    accountEmail: row.accountEmail,
    cardLastFour: row.cardLastFour,
    fetchedAt: row.fetchedAt,
    payloadJson: row.payloadJson,
  };
}

export async function getUpstreamSnapshots(orderIds: number[]) {
  const out = new Map<number, UpstreamSnapshot>();
  if (!orderIds.length) return out;
  const rows = await db
    .select()
    .from(orderUpstreamSnapshots)
    .where(inArray(orderUpstreamSnapshots.orderId, orderIds));
  for (const row of rows) {
    out.set(row.orderId, {
      status: row.status,
      stage: row.stage,
      message: row.message,
      accountEmail: row.accountEmail,
      cardLastFour: row.cardLastFour,
      fetchedAt: row.fetchedAt,
      payloadJson: row.payloadJson,
    });
  }
  return out;
}

export type { RedeemTimelineEvent };
