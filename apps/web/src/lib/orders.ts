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
import {
  findIssuedCdkByCode,
  nestedString,
} from "@/lib/cardplatform/issued-redemption";
import { injectRedeemCardPolicy } from "@/lib/cardplatform/policy";

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

export type OpenedRechargeOrder = {
  order: typeof orders.$inferSelect;
  issuedId: number | null;
  planKey: string;
};

/**
 * 建单阶段：只碰本地库，不打卡台。
 *
 * 批量提交必须能立刻把 N 张的单号还给前端——每次卡台调用最长 45 秒，20 张的
 * 预检加兑换挤在一个 HTTP 响应里必然超时。所以抢卡、建单、写历史在请求里同步做完，
 * 真正的上游调用交给 driveRechargeOrder。
 */
export async function openRechargeOrder(input: {
  code: string;
  email: string;
  account: AgentCredential;
  planKey?: string;
}): Promise<OpenedRechargeOrder> {
  await bootDb();
  const issued = await findIssuedCdkByCode(input.code);
  if (issued) {
    if (issued.status === "used") throw new Error("该卡密已使用");
    if (issued.status === "locked" || issued.status === "redeeming") {
      throw new Error("该卡密兑换处理中，请稍后查询");
    }
    if (issued.status === "disabled") throw new Error("该卡密已禁用");
  }

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

  const planKey = input.planKey || issued?.planKey || "";
  const orderNo = newOrderNo("RC");
  try {
    const [created] = await db
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
        upstreamPlan: planKey,
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
    return { order: created, issuedId: issued?.id ?? null, planKey };
  } catch (error) {
    // 卡已经抢成 locked 了，建单没成就得放回去，否则这张既卖不出也兑不了。
    if (issued) {
      await db
        .update(issuedCdks)
        .set({
          status: "unused",
          redemptionOrderId: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(issuedCdks.id, issued.id));
    }
    throw error;
  }
}

/**
 * 兑换阶段：预检 → 提交卡台 → 回写订单和卡密状态。
 *
 * 异常一律收进返回值：批量跑 20 张时一张出错不能带倒整批，要不要报错交给调用方。
 * 关键分岔在 redeemStarted——兑换请求一旦发出去就再也不能说「失败」了，只能是
 * unknown。卡台可能已经扣过费，重提等于让客户被扣两次。
 */
export async function driveRechargeOrder(input: {
  opened: OpenedRechargeOrder;
  code: string;
  account: AgentCredential;
}): Promise<{ order: typeof orders.$inferSelect; error?: Error }> {
  const { opened } = input;
  let redeemStarted = false;
  let accountId = 0;
  let redemptionToken = "";
  try {
    const prepared = await preflightRedeemableCdk({
      code: input.code,
      account: input.account,
      // 这张卡的 locked 是 openRechargeOrder 自己抢下来的，预检不能把它当成
      // 「别人在兑换」，否则本站发出去的卡一张也兑不掉。
      allowInFlight: true,
    });
    accountId = prepared.redeemable.accountId;
    redemptionToken = prepared.redemptionToken;
    const { client } = await resolveRedeemClient(prepared.redeemable.code);
    redeemStarted = true;
    // 后台配的选卡策略和拉黑名单只有注进 redeem body 才生效。这里以前是直接调
    // client.redeemCdk，所以「严格按偏好选卡」「不许自动换卡」「排除这些卡」对客户
    // 兑换全都没起过作用。
    const redeemed = await client.redeemCdk(
      await injectRedeemCardPolicy(
        {
          redemption_token: prepared.redemptionToken,
          preflight_token: prepared.preflightToken,
          client_request_id: opened.order.orderNo,
        },
        accountId,
      ),
    );
    const status = mapCardplatformStatus(redeemed.payload, redeemed.ok);
    const message =
      nestedString(redeemed.payload, "message", "msg") ||
      (status === "success" ? "兑换成功" : "已提交卡台处理");
    const terminalSuccess = status === "success" || status === "skipped";
    const terminalFailure = status === "failed";
    const now = new Date().toISOString();
    const [updated] = await db.transaction(async (tx) => {
      if (opened.issuedId) {
        await tx
          .update(issuedCdks)
          .set({
            status: terminalSuccess
              ? "used"
              : terminalFailure
                ? "unused"
                : "redeeming",
            usedAt: terminalSuccess ? now : null,
            updatedAt: now,
          })
          .where(eq(issuedCdks.id, opened.issuedId));
      }
      return tx
        .update(orders)
        .set({
          fulfillStatus: status,
          upstreamRequestId: requestIdForRedeem(accountId, redemptionToken),
          upstreamPlan: prepared.redeemable.planKey || opened.planKey,
          message,
          paidAt: opened.order.paidAt || now,
          accountEmail: prepared.accountEmail || opened.order.accountEmail,
          updatedAt: now,
        })
        .where(eq(orders.id, opened.order.id))
        .returning();
    });
    await appendStatusHistory(
      opened.order.id,
      updated?.fulfillStatus || status,
      updated?.message || message,
      "cardplatform",
    );
    if (updated && isTerminalStatus(updated.fulfillStatus)) {
      await notifyIfTerminal(updated);
    }
    return { order: updated ?? opened.order };
  } catch (error) {
    const unknown = redeemStarted;
    const now = new Date().toISOString();
    if (opened.issuedId) {
      await db
        .update(issuedCdks)
        .set({ status: unknown ? "redeeming" : "unused", updatedAt: now })
        .where(eq(issuedCdks.id, opened.issuedId));
    }
    const message = error instanceof Error ? error.message : "卡台兑换失败";
    const [updated] = await db
      .update(orders)
      .set({
        fulfillStatus: unknown ? "unknown" : "failed",
        // 结果未知时必须把 request_id 存下来：服务端兜底轮询只认这个字段，
        // 存不上这一单就再没人去卡台核对，客户的卡就这么悬着了。
        upstreamRequestId:
          unknown && redemptionToken
            ? requestIdForRedeem(accountId, redemptionToken)
            : opened.order.upstreamRequestId,
        message,
        updatedAt: now,
      })
      .where(eq(orders.id, opened.order.id))
      .returning();
    await appendStatusHistory(
      opened.order.id,
      unknown ? "unknown" : "failed",
      message,
      "cardplatform",
    );
    await notifyIfTerminal({
      orderNo: opened.order.orderNo,
      fulfillStatus: unknown ? "unknown" : "failed",
      message,
      upstreamRequestId:
        updated?.upstreamRequestId || opened.order.upstreamRequestId,
      upstreamPlan: opened.order.upstreamPlan,
    });
    return {
      order: updated ?? opened.order,
      error: error instanceof Error ? error : new Error(message),
    };
  }
}

async function createCardplatformRecharge(input: {
  email: string;
  account: AgentCredential;
  cdkCode: string;
}) {
  // 单张路径先 preview 再建单：卡密本身不对就直接报错，不给客户留一笔失败的 RC 单。
  const preview = await previewRedeemableCdk(input.cdkCode);
  const opened = await openRechargeOrder({
    code: preview.redeemable.code,
    email: input.email,
    account: input.account,
    planKey: preview.redeemable.planKey,
  });
  const { order, error } = await driveRechargeOrder({
    opened,
    code: preview.redeemable.code,
    account: input.account,
  });
  if (error) throw error;
  return order;
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
