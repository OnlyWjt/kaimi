import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { findIssuedCdkByCode } from "@/lib/cardplatform/issued-redemption";
import {
  previewRedeemableCdk,
  summarizePreview,
} from "@/lib/cardplatform/redeem";
import { bootDb } from "@/lib/config";
import { maskCode } from "@/lib/crypto";
import { sanitizeLog } from "@/lib/log";
import { isOrderTerminalStatus } from "@/lib/order-status";
import {
  driveRechargeOrder,
  getStatusHistory,
  pollRechargeIfNeeded,
  type OpenedRechargeOrder,
} from "@/lib/orders";
import { REDEEM_BATCH_CONCURRENCY, mapPool } from "@/lib/recharge-batch-core";
import type { AgentCredential } from "@/lib/recharge-types";

export type BatchPreviewRow = {
  code: string;
  codeMasked: string;
  ok: boolean;
  planKey: string;
  planName: string;
  /** 这张卡已经在兑换或已兑换过时给出对应的 RC 单号，界面接着查就行，不用重提。 */
  orderNo: string;
  error: string;
};

/**
 * 已经开始兑换的卡不能再走一遍：如果它挂着一笔 RC 单，把单号带回去让界面接着轮询。
 * 这是买家提交时断网后唯一的自救路径——重新校验一次就能把那几张接回进度里。
 */
async function inFlightOrderNo(code: string) {
  const issued = await findIssuedCdkByCode(code);
  if (!issued?.redemptionOrderId) return "";
  const order = await db.query.orders.findFirst({
    where: eq(orders.id, issued.redemptionOrderId),
  });
  return order?.orderNo || "";
}

/** 批量校验：逐张打卡台 preview，有界并发，一张失败不影响其余。 */
export async function previewRedeemCodes(
  codes: string[],
): Promise<BatchPreviewRow[]> {
  await bootDb();
  return mapPool(codes, REDEEM_BATCH_CONCURRENCY, async (code) => {
    const base = {
      code,
      codeMasked: maskCode(code),
      planKey: "",
      planName: "",
      orderNo: "",
    };
    try {
      const previewed = await previewRedeemableCdk(code);
      const summary = summarizePreview(previewed);
      return {
        ...base,
        ok: true,
        codeMasked: summary.codeMasked,
        planKey: summary.planKey,
        planName: summary.planName,
        error: "",
      };
    } catch (error) {
      return {
        ...base,
        ok: false,
        orderNo: await inFlightOrderNo(code).catch(() => ""),
        error: error instanceof Error ? error.message : "卡密校验失败",
      };
    }
  });
}

/**
 * 兑换阶段的批量驱动，跑在 after() 里。
 *
 * 凭证只活在这次请求的内存里。要让批量在服务端可恢复就得把客户的 Session JSON
 * 或邮箱密码落库，那是不可接受的，所以这里不落任何凭证、不建批次表、不排后台任务。
 */
export async function driveRechargeBatch(
  items: Array<{ opened: OpenedRechargeOrder; code: string }>,
  account: AgentCredential,
) {
  await mapPool(items, REDEEM_BATCH_CONCURRENCY, async (item) => {
    const { error } = await driveRechargeOrder({
      opened: item.opened,
      code: item.code,
      account,
    });
    if (error) {
      console.warn(
        `[kaimi] batch redeem order=${item.opened.order.orderNo}`,
        sanitizeLog(error.message),
      );
    }
  });
}

export type BatchOrderRow = {
  orderNo: string;
  fulfillStatus: string;
  message: string;
  accountEmail: string;
  history: Array<{ status: string; message: string; at: string }>;
};

/**
 * 批量进度：一次请求核完整批。
 *
 * 20 张卡各自轮询单张查询接口会瞬间打爆 shop-query 的额度，所以这里收成一次调用，
 * 只对未终态的单去卡台核一遍。
 */
export async function readRechargeBatchOrders(
  orderNos: string[],
): Promise<BatchOrderRow[]> {
  await bootDb();
  const wanted = orderNos.map((no) => no.trim()).filter(Boolean);
  if (!wanted.length) return [];

  const known = await db.query.orders.findMany({
    where: inArray(orders.orderNo, wanted),
    limit: wanted.length,
  });
  const stale = known.filter(
    (order) => !isOrderTerminalStatus(order.fulfillStatus),
  );
  await mapPool(stale, REDEEM_BATCH_CONCURRENCY, async (order) => {
    await pollRechargeIfNeeded(order.orderNo).catch(() => null);
  });

  const fresh = await db.query.orders.findMany({
    where: inArray(orders.orderNo, wanted),
    limit: wanted.length,
  });
  return Promise.all(
    fresh.map(async (order) => ({
      orderNo: order.orderNo,
      fulfillStatus: order.fulfillStatus,
      message: order.message,
      accountEmail: order.accountEmail || order.email || "",
      history: (await getStatusHistory(order.id)).map((row) => ({
        status: row.status,
        message: row.message,
        at: row.createdAt,
      })),
    })),
  );
}
