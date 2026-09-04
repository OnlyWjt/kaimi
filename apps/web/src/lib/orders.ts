import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  cdkPool,
  issuedCdks,
  orderStatusHistory,
  orders,
  products,
} from "@/db/schema";
import { bootDb, getAppConfig } from "@/lib/config";
import { newOrderNo } from "@/lib/ids";
import {
  markCodeUsed,
  markCodesSold,
  releaseLockedCode,
  reserveCodes,
} from "@/lib/inventory";
import { notifyOrderTerminal } from "@/lib/notify";
import type { AgentCredential } from "@/lib/recharge-types";
import { isTerminalStatus } from "@/lib/recharge-types";
import {
  mapCardplatformStatus,
  parseCardplatformRequestId,
  pollCardplatformResult,
  preflightRedeemableCdk,
  previewRedeemableCdk,
  requestIdForRedeem,
  resolveRedeemClient,
} from "@/lib/cardplatform/redeem";
import { nestedString } from "@/lib/cardplatform/issued-redemption";

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

async function createCardplatformRecharge(input: {
  email: string;
  account: AgentCredential;
  cdkCode: string;
}) {
  const preview = await previewRedeemableCdk(input.cdkCode);
  const issued = preview.redeemable.issued;
  const now = new Date().toISOString();

  if (issued) {
    const [claimed] = await db
      .update(issuedCdks)
      .set({ status: "locked", updatedAt: now })
      .where(
        and(eq(issuedCdks.id, issued.id), eq(issuedCdks.status, "unused")),
      )
      .returning();
    if (!claimed) throw new Error("该卡密已使用或正在兑换");
  }

  const orderNo = newOrderNo("RC");
  let created: typeof orders.$inferSelect | undefined;
  let redeemStarted = false;
  let redemptionToken = preview.redemptionToken;
  try {
    [created] = await db
      .insert(orders)
      .values({
        orderNo,
        kind: "recharge",
        email: input.email.trim().toLowerCase(),
        quantity: 1,
        amountCents: 0,
        currency: "CNY",
        payStatus: "manual",
        fulfillStatus: "pending",
        paymentChannel: issued ? "issued_cdk" : "cardplatform",
        upstreamPlan: preview.redeemable.planKey,
        clientReference: orderNo,
        credMode: input.account.mode,
        accountEmail: input.account.email || input.email,
      })
      .returning();
    if (!created) throw new Error("兑换订单创建失败");
    if (issued) {
      await db
        .update(issuedCdks)
        .set({ redemptionOrderId: created.id, updatedAt: now })
        .where(eq(issuedCdks.id, issued.id));
    }
    await appendStatusHistory(
      created.id,
      "pending",
      "订单已创建，正在直连卡台兑换",
      "cardplatform",
    );

    const prepared = await preflightRedeemableCdk({
      code: preview.redeemable.code,
      account: input.account,
      // 这张卡的 locked 是上面几行自己抢下来的，预检不能把它当成「别人在兑换」。
      allowInFlight: true,
    });
    redemptionToken = prepared.redemptionToken;
    const { client } = await resolveRedeemClient(prepared.redeemable.code);
    redeemStarted = true;
    const redeemed = await client.redeemCdk({
      redemption_token: prepared.redemptionToken,
      preflight_token: prepared.preflightToken,
      client_request_id: orderNo,
    });
    const status = mapCardplatformStatus(redeemed.payload, redeemed.ok);
    const message =
      nestedString(redeemed.payload, "message", "msg") ||
      (status === "success" ? "兑换成功" : "已提交卡台处理");
    const terminalSuccess = status === "success" || status === "skipped";
    const terminalFailure = status === "failed";
    const [updated] = await db.transaction(async (tx) => {
      if (issued) {
        await tx
          .update(issuedCdks)
          .set({
            status: terminalSuccess
              ? "used"
              : terminalFailure
                ? "unused"
                : "redeeming",
            usedAt: terminalSuccess ? new Date().toISOString() : null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(issuedCdks.id, issued.id));
      }
      return tx
        .update(orders)
        .set({
          fulfillStatus: status,
          upstreamRequestId: requestIdForRedeem(
            prepared.redeemable.accountId,
            redemptionToken,
          ),
          message,
          paidAt: now,
          accountEmail: prepared.accountEmail || created!.accountEmail,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(orders.id, created!.id))
        .returning();
    });
    await appendStatusHistory(
      created.id,
      updated?.fulfillStatus || status,
      updated?.message || message,
      "cardplatform",
    );
    if (updated && isTerminalStatus(updated.fulfillStatus)) {
      await notifyIfTerminal(updated);
    }
    return updated ?? created;
  } catch (error) {
    const unknown = redeemStarted;
    if (issued) {
      await db
        .update(issuedCdks)
        .set({
          status: unknown ? "redeeming" : "unused",
          redemptionOrderId: created?.id ?? null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(issuedCdks.id, issued.id));
    }
    if (created) {
      const message = error instanceof Error ? error.message : "卡台兑换失败";
      await db
        .update(orders)
        .set({
          fulfillStatus: unknown ? "unknown" : "failed",
          upstreamRequestId:
            unknown && redemptionToken
              ? requestIdForRedeem(preview.redeemable.accountId, redemptionToken)
              : created.upstreamRequestId,
          message,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(orders.id, created.id));
      await appendStatusHistory(
        created.id,
        unknown ? "unknown" : "failed",
        message,
        "cardplatform",
      );
      await notifyIfTerminal({
        orderNo: created.orderNo,
        fulfillStatus: unknown ? "unknown" : "failed",
        message,
        upstreamRequestId: created.upstreamRequestId,
        upstreamPlan: created.upstreamPlan,
      });
    }
    throw error;
  }
}

export async function createRechargeOrder(input: {
  cdkCode: string;
  email: string;
  account: AgentCredential;
  productId?: number;
}) {
  await bootDb();
  const code = input.cdkCode.trim();
  if (!code) throw new Error("请填写卡密");
  return createCardplatformRecharge({
    cdkCode: code,
    email: input.email,
    account: input.account,
  });
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

async function pollDirectCardplatformOrder(order: typeof orders.$inferSelect) {
  const parsed = parseCardplatformRequestId(order.upstreamRequestId || "");
  if (!parsed) throw new Error("卡台兑换请求标识无效");
  const result = await pollCardplatformResult(order.upstreamRequestId || "");
  const status = result.status;
  const message = result.message;
  const terminalSuccess = status === "success" || status === "skipped";
  const terminalFailure = status === "failed";
  await db.transaction(async (tx) => {
    await tx
      .update(orders)
      .set({
        fulfillStatus: status,
        message,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(orders.id, order.id));
    if (terminalSuccess || terminalFailure) {
      await tx
        .update(issuedCdks)
        .set({
          status: terminalSuccess ? "used" : "unused",
          usedAt: terminalSuccess ? new Date().toISOString() : null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(issuedCdks.redemptionOrderId, order.id));
    }
  });
  await appendStatusHistory(order.id, status, message, "cardplatform-poll");
}

export async function pollRechargeByRequestId(requestId: string) {
  await bootDb();
  const rid = requestId.trim();
  if (!rid) throw new Error("缺少 request_id");
  if (!rid.startsWith("cp:")) {
    throw new Error("旧上游兑换已停用，请用卡台兑换单号查询");
  }
  const directOrders = await db.query.orders.findMany({
    where: eq(orders.upstreamRequestId, rid),
    limit: 20,
  });
  for (const order of directOrders) await pollDirectCardplatformOrder(order);
  return db.query.orders.findMany({
    where: eq(orders.upstreamRequestId, rid),
    limit: 20,
  });
}

export async function pollRechargeIfNeeded(orderNo: string) {
  await bootDb();
  const order = await db.query.orders.findFirst({
    where: eq(orders.orderNo, orderNo),
  });
  if (!order?.upstreamRequestId) return order;
  if (!order.upstreamRequestId.startsWith("cp:")) {
    return order;
  }
  if (["success", "failed", "skipped"].includes(order.fulfillStatus)) {
    return order;
  }
  await pollDirectCardplatformOrder(order);
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
        sql`(${orders.fulfillStatus} NOT IN ('success', 'failed', 'skipped', 'unknown', 'fulfilled')
          OR (
            ${orders.upstreamRequestId} LIKE 'cp:%'
            AND ${orders.fulfillStatus} = 'unknown'
            AND ${orders.createdAt} >= datetime('now', '-1 day')
          ))`,
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
