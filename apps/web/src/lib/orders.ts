import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { cdkPool, orderStatusHistory, orders, products } from "@/db/schema";
import { bootDb, getAppConfig } from "@/lib/config";
import { newIdempotencyKey, newOrderNo } from "@/lib/ids";
import {
  lockCodeForRedeem,
  markCodeUsed,
  markCodesSold,
  releaseLockedCode,
  reserveCodes,
  ensureUpstreamCdkUsable,
  findCdkByCode,
} from "@/lib/inventory";
import { notifyOrderTerminal } from "@/lib/notify";
import { getUpstreamClient } from "@/lib/upstream";
import type { AgentCredential, ItemStatus } from "@kaimi/upstream";
import { isTerminalStatus } from "@kaimi/upstream";

export async function appendStatusHistory(
  orderId: number,
  status: string,
  message: string,
  source = "system",
) {
  const last = await db.query.orderStatusHistory.findFirst({
    where: eq(orderStatusHistory.orderId, orderId),
    orderBy: [desc(orderStatusHistory.id)],
  });
  if (last && last.status === status && last.message === (message || "")) return;
  await db.insert(orderStatusHistory).values({
    orderId,
    status,
    message: message || "",
    source,
  });
}

export async function getStatusHistory(orderId: number) {
  return db.query.orderStatusHistory.findMany({
    where: eq(orderStatusHistory.orderId, orderId),
    orderBy: [asc(orderStatusHistory.id)],
    limit: 80,
  });
}

async function notifyIfTerminal(order: {
  orderNo: string;
  fulfillStatus: string;
  message: string;
  upstreamRequestId?: string | null;
  upstreamPlan?: string | null;
}) {
  if (!isTerminalStatus(order.fulfillStatus)) return;
  await notifyOrderTerminal({
    orderNo: order.orderNo,
    status: order.fulfillStatus,
    message: order.message,
    requestId: order.upstreamRequestId,
    plan: order.upstreamPlan || undefined,
  }).catch((err) => console.warn("[kaimi] notify skipped", err));
}

export async function createCodeOrder(input: {
  productId: number;
  email: string;
  quantity?: number;
}) {
  await bootDb();
  const product = await db.query.products.findFirst({
    where: eq(products.id, input.productId),
  });
  if (!product || !product.enabled || product.kind !== "code") {
    throw new Error("商品不存在或未上架");
  }

  const quantity = Math.max(1, Math.min(10, input.quantity ?? 1));
  const cfg = await getAppConfig();
  const orderNo = newOrderNo("SC");
  const amount = product.priceCents * quantity;

  const [created] = await db
    .insert(orders)
    .values({
      orderNo,
      kind: "code",
      productId: product.id,
      email: input.email.trim().toLowerCase(),
      quantity,
      amountCents: amount,
      currency: product.currency,
      payStatus: cfg.paymentMode === "manual" ? "manual" : "unpaid",
      fulfillStatus: "pending",
      paymentChannel: cfg.paymentMode,
      upstreamPlan: product.upstreamPlan,
      clientReference: orderNo,
    })
    .returning();

  if (cfg.paymentMode === "manual") {
    return fulfillCodeOrder(created.id);
  }

  return created;
}

export async function fulfillCodeOrder(orderId: number) {
  await bootDb();
  const order = await db.query.orders.findFirst({
    where: eq(orders.id, orderId),
  });
  if (!order) throw new Error("订单不存在");
  if (order.kind !== "code") throw new Error("非售码订单");
  if (order.fulfillStatus === "fulfilled") return order;

  const reserved = await reserveCodes(order.upstreamPlan, order.quantity, order.id);
  await markCodesSold(reserved.map((r) => r.id));
  const codes = reserved.map((r) => r.code);

  const [updated] = await db
    .update(orders)
    .set({
      payStatus: order.payStatus === "unpaid" ? "paid" : order.payStatus,
      fulfillStatus: "fulfilled",
      deliveredCodesJson: JSON.stringify(codes),
      paidAt: order.paidAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      message: "已发码",
    })
    .where(eq(orders.id, order.id))
    .returning();

  await appendStatusHistory(order.id, "fulfilled", "已发码", "shop");
  return updated;
}

export async function createRechargeOrder(input: {
  /** 客户持码兑换：传入卡密后自动识别套餐 */
  cdkCode: string;
  email: string;
  account: AgentCredential;
  /** 兼容旧调用；有卡密时以卡密套餐为准 */
  productId?: number;
}) {
  await bootDb();
  const code = input.cdkCode.trim();
  if (!code) throw new Error("请填写卡密");

  let cdk = await findCdkByCode(code);
  if (!cdk) throw new Error("卡密不存在");
  if (cdk.status === "used") throw new Error("该卡密已使用");
  if (cdk.status === "locked") throw new Error("该卡密占用中，请查询订单进度");

  // 先问上游：误禁用可恢复；真正收回再拒绝
  await ensureUpstreamCdkUsable(cdk.planKey, cdk.code);
  cdk = (await findCdkByCode(code)) ?? cdk;

  if (cdk.status === "disabled") {
    throw new Error("该卡密已不可用");
  }
  if (cdk.status !== "unused" && cdk.status !== "sold") {
    throw new Error(`卡密状态不可兑换：${cdk.status}`);
  }

  let product =
    input.productId != null
      ? await db.query.products.findFirst({ where: eq(products.id, input.productId) })
      : null;
  if (!product || product.upstreamPlan !== cdk.planKey) {
    product =
      (await db.query.products.findFirst({
        where: and(
          eq(products.upstreamPlan, cdk.planKey),
          eq(products.kind, "recharge"),
          eq(products.enabled, true),
        ),
      })) ?? null;
  }
  if (product && (!product.enabled || product.kind !== "recharge")) {
    product = null;
  }

  const cfg = await getAppConfig();
  const orderNo = newOrderNo("RC");

  const [created] = await db
    .insert(orders)
    .values({
      orderNo,
      kind: "recharge",
      productId: product?.id ?? null,
      email: input.email.trim().toLowerCase(),
      quantity: 1,
      amountCents: product?.priceCents ?? 0,
      currency: product?.currency ?? "CNY",
      payStatus: cfg.paymentMode === "manual" ? "manual" : "unpaid",
      fulfillStatus: "pending",
      paymentChannel: cfg.paymentMode,
      upstreamPlan: cdk.planKey,
      clientReference: orderNo,
      credMode: input.account.mode,
      accountEmail: input.account.email || input.email,
    })
    .returning();

  await appendStatusHistory(created.id, "pending", "订单已创建，准备提交上游", "submit");

  if (cfg.paymentMode === "manual") {
    return submitRecharge(created.id, input.account, code);
  }

  return created;
}

export async function submitRecharge(
  orderId: number,
  account: AgentCredential,
  /** 客户持码兑换时传入；未传则从代理库存随机锁一张 */
  cdkCode?: string,
) {
  await bootDb();
  const order = await db.query.orders.findFirst({
    where: eq(orders.id, orderId),
  });
  if (!order) throw new Error("订单不存在");
  if (order.kind !== "recharge") throw new Error("非代充订单");
  if (order.fulfillStatus === "unknown") {
    throw new Error("开通结果待确认，请勿重复提交");
  }
  if (order.upstreamRequestId && isTerminalStatus(order.fulfillStatus) === false) {
    throw new Error("开通进行中，请勿重复提交");
  }
  if (["success", "skipped"].includes(order.fulfillStatus)) {
    throw new Error("订单已完成");
  }

  const code = cdkCode?.trim()
    ? (await lockCodeForRedeem(cdkCode.trim(), order.id)).code
    : (await reserveCodes(order.upstreamPlan, 1, order.id))[0]!.code;

  try {
    const upstream = await getUpstreamClient();
    const idem = newIdempotencyKey();
    const res = await upstream.createRecharge(
      {
        plan: order.upstreamPlan,
        cdk_code: code,
        account,
        client_reference: order.clientReference || order.orderNo,
      },
      idem,
    );

    // 主站创建接口可能返回批次态 running；去重时也可能直接返回已失败的旧任务。
    let status = (res.status as ItemStatus) || "pending";
    if (status === ("running" as ItemStatus) || (status as string) === "running") {
      status = "pending";
    }
    const deduped = Boolean((res as { deduped?: boolean }).deduped);
    const message =
      res.message ||
      (deduped
        ? status === "failed"
          ? "已关联到先前同一账号的失败记录"
          : "已关联到先前同一账号的开通记录"
        : "已提交");

    const [updated] = await db
      .update(orders)
      .set({
        payStatus: order.payStatus === "unpaid" ? "paid" : order.payStatus,
        fulfillStatus: status,
        upstreamRequestId: res.request_id,
        message,
        deliveredCodesJson: JSON.stringify([]), // never expose code on recharge
        paidAt: order.paidAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        accountEmail: account.email || order.accountEmail,
        credMode: account.mode,
      })
      .where(eq(orders.id, order.id))
      .returning();

    // 创建响应若已是终态，必须立刻处理卡密（去重失败时尤其容易漏解锁）
    if (status === "success" || status === "skipped") {
      await markCodeUsed(code);
    } else if (status === "failed" || status === "unknown") {
      await releaseLockedCode(code);
    }
    // pending / processing 等：保持 locked，等 webhook / 轮询

    if (updated) {
      await appendStatusHistory(
        updated.id,
        updated.fulfillStatus,
        updated.message,
        deduped ? "upstream-dedupe" : "submit",
      );
      if (isTerminalStatus(updated.fulfillStatus)) {
        await notifyIfTerminal(updated);
      }
    }

    return updated;
  } catch (err) {
    await releaseLockedCode(code);
    const message = err instanceof Error ? err.message : "提交上游失败";
    await db
      .update(orders)
      .set({
        fulfillStatus: "failed",
        message,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(orders.id, order.id));
    await appendStatusHistory(order.id, "failed", message, "submit");
    await notifyIfTerminal({
      orderNo: order.orderNo,
      fulfillStatus: "failed",
      message,
      upstreamRequestId: order.upstreamRequestId,
      upstreamPlan: order.upstreamPlan,
    });
    throw err;
  }
}

export async function applyUpstreamStatus(opts: {
  requestId?: string;
  clientReference?: string;
  status?: string;
  message?: string;
  cdkCode?: string;
}) {
  await bootDb();
  const matched: Array<typeof orders.$inferSelect> = [];

  // 优先按业务单号精确匹配；同 request_id 可能因主站去重挂在多笔本地单上
  if (opts.clientReference) {
    const byRef = await db.query.orders.findFirst({
      where: eq(orders.clientReference, opts.clientReference),
    });
    if (byRef) matched.push(byRef);
  }
  if (opts.requestId) {
    const byReq = await db.query.orders.findMany({
      where: eq(orders.upstreamRequestId, opts.requestId),
    });
    for (const o of byReq) {
      if (!matched.some((m) => m.id === o.id)) matched.push(o);
    }
  }
  if (!matched.length) return null;

  const status = opts.status || matched[0]!.fulfillStatus;
  let last = matched[0]!;

  for (const order of matched) {
    const prev = order.fulfillStatus;
    const nextMessage = opts.message || order.message;
    await db
      .update(orders)
      .set({
        fulfillStatus: status,
        message: nextMessage,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(orders.id, order.id));

    await appendStatusHistory(order.id, status, nextMessage, "upstream");

    if (status === "success" || status === "skipped") {
      const row = await db.query.cdkPool.findFirst({
        where: eq(cdkPool.orderId, order.id),
      });
      if (row) await markCodeUsed(row.code);
      else if (opts.cdkCode) await markCodeUsed(opts.cdkCode);
    }

    if (status === "failed" || status === "unknown") {
      await releaseCodesForOrder(order.id);
      if (opts.cdkCode) await releaseLockedCode(opts.cdkCode);
    }

    if (isTerminalStatus(status) && !isTerminalStatus(prev)) {
      await notifyIfTerminal({
        orderNo: order.orderNo,
        fulfillStatus: status,
        message: nextMessage,
        upstreamRequestId: order.upstreamRequestId,
        upstreamPlan: order.upstreamPlan,
      });
    }
    last = { ...order, fulfillStatus: status, message: nextMessage };
  }

  return last;
}

/** 订单已终态失败/unknown 时释放关联锁定卡密 */
export async function releaseCodesForOrder(orderId: number) {
  await bootDb();
  const rows = await db.query.cdkPool.findMany({
    where: and(eq(cdkPool.orderId, orderId), eq(cdkPool.status, "locked")),
  });
  for (const row of rows) {
    await releaseLockedCode(row.code);
  }
}

/** 修补：订单已 failed/unknown/success，但卡密仍 locked */
export async function reconcileStuckLocks() {
  await bootDb();
  const locked = await db.query.cdkPool.findMany({
    where: eq(cdkPool.status, "locked"),
  });
  let released = 0;
  let used = 0;
  for (const row of locked) {
    if (!row.orderId) {
      await releaseLockedCode(row.code);
      released += 1;
      continue;
    }
    const order = await db.query.orders.findFirst({ where: eq(orders.id, row.orderId) });
    if (!order) {
      await releaseLockedCode(row.code);
      released += 1;
      continue;
    }
    if (order.fulfillStatus === "success" || order.fulfillStatus === "skipped") {
      await markCodeUsed(row.code);
      used += 1;
    } else if (
      order.fulfillStatus === "failed" ||
      order.fulfillStatus === "unknown" ||
      // 创建接口误把批次 running 当进行中但实际已无 request：保守不在此释放 running/pending
      false
    ) {
      await releaseLockedCode(row.code);
      released += 1;
    }
  }
  return { released, used, checked: locked.length };
}

export async function pollRechargeByRequestId(requestId: string) {
  await bootDb();
  const rid = requestId.trim();
  if (!rid) throw new Error("缺少 request_id");
  const client = await getUpstreamClient();
  const res = await client.getRecharge(rid);
  await applyUpstreamStatus({
    requestId: res.request_id || rid,
    clientReference: res.client_reference,
    status: res.status,
    message: res.message,
  });
  return db.query.orders.findMany({
    where: eq(orders.upstreamRequestId, res.request_id || rid),
    limit: 20,
  });
}

export async function pollRechargeIfNeeded(orderNo: string) {
  await bootDb();
  const order = await db.query.orders.findFirst({
    where: eq(orders.orderNo, orderNo),
  });
  if (!order?.upstreamRequestId) return order;
  if (isTerminalStatus(order.fulfillStatus)) return order;

  const client = await getUpstreamClient();
  const res = await client.getRecharge(order.upstreamRequestId);
  await applyUpstreamStatus({
    requestId: res.request_id,
    clientReference: res.client_reference,
    status: res.status,
    message: res.message,
  });

  return db.query.orders.findFirst({ where: eq(orders.orderNo, orderNo) });
}

/** 非终态且已有 request_id 的开通单：服务端兜底拉主站状态 */
export async function pollInFlightOrders(limit = 25) {
  await bootDb();
  const list = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.kind, "recharge"),
        sql`${orders.upstreamRequestId} IS NOT NULL AND ${orders.upstreamRequestId} != ''`,
        sql`${orders.fulfillStatus} NOT IN ('success', 'failed', 'skipped', 'unknown', 'fulfilled')`,
      ),
    )
    .orderBy(desc(orders.id))
    .limit(limit);

  let polled = 0;
  let errors = 0;
  for (const order of list) {
    try {
      await pollRechargeIfNeeded(order.orderNo);
      polled += 1;
    } catch (err) {
      errors += 1;
      console.warn("[kaimi] poll inflight failed", order.orderNo, err);
    }
  }
  return { checked: list.length, polled, errors };
}

export async function countInFlightRecharges() {
  await bootDb();
  const rows = await db
    .select({ c: sql<number>`count(*)` })
    .from(orders)
    .where(
      and(
        eq(orders.kind, "recharge"),
        sql`${orders.fulfillStatus} NOT IN ('success', 'failed', 'skipped', 'unknown', 'fulfilled')`,
      ),
    );
  return Number(rows[0]?.c ?? 0);
}
