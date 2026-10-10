import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import {
  DrawError,
  drawLedgerOverview,
  getDrawBill,
  grantDrawAccess,
  listDrawLedgerAgents,
  listPendingDrawApplications,
  listStuckDrawOrders,
  listUnsettledDrawItems,
  manualUseDrawItem,
  markDrawOrderFailed,
  recoverDrawOrder,
  rejectDrawApplication,
  resumeDrawAccess,
  revertDrawBill,
  settleDrawItems,
  suspendDrawAccess,
  updateDrawCredit,
  updateDrawSettings,
  voidDrawItem,
} from "@/lib/agent-draw";
import { bootDb } from "@/lib/config";
import { normalizePage, normalizePageSize } from "@/lib/pagination-core";

async function admin() {
  try {
    return await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

export async function GET(req: Request) {
  const session = await admin();
  if (session instanceof Response) return session;
  await bootDb();
  const params = new URL(req.url).searchParams;
  const agentId = Number(params.get("agentId") || 0);
  const billId = Number(params.get("billId") || 0);
  const itemPage = normalizePage(params.get("itemPage"));
  const itemPageSize = normalizePageSize(params.get("itemPageSize"));
  try {
  const [overview, agents, applications, itemPageResult, stuck, bill] = await Promise.all([
    drawLedgerOverview(),
    listDrawLedgerAgents(),
    listPendingDrawApplications(),
    agentId > 0
      ? listUnsettledDrawItems(agentId, { page: itemPage, pageSize: itemPageSize })
      : Promise.resolve({ items: [], total: 0, page: 1, pageSize: itemPageSize }),
    agentId > 0 ? listStuckDrawOrders(agentId) : Promise.resolve([]),
    billId > 0 ? getDrawBill(billId).catch(() => null) : Promise.resolve(null),
  ]);
  return NextResponse.json({
    overview,
    agents,
    applications,
    items: itemPageResult.items,
    codesUnavailable: "codesUnavailable" in itemPageResult ? itemPageResult.codesUnavailable : false,
    itemTotal: itemPageResult.total,
    itemPage: itemPageResult.page,
    itemPageSize: itemPageResult.pageSize,
    stuck,
    bill,
  });
  } catch (error) {
    const message = error instanceof Error ? error.message : "提卡账本加载失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

const postSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("settle"),
    agentId: z.number().int().positive(),
    itemIds: z.array(z.number().int().positive()).min(1),
    expectedAmountCents: z.number().int().nonnegative(),
    paymentMethod: z.enum(["alipay", "wechat", "usdt", "bank", "other"]),
    paymentReference: z.string().trim().max(120).default(""),
    notes: z.string().trim().max(500).default(""),
  }),
  z.object({
    action: z.literal("grant"),
    agentId: z.number().int().positive(),
    creditLimitCents: z.number().int().positive().optional(),
  }),
  z.object({
    action: z.literal("credit"),
    agentId: z.number().int().positive(),
    creditLimitCents: z.number().int().positive(),
  }),
  z.object({
    action: z.literal("settings"),
    agentId: z.number().int().positive(),
    creditLimitCents: z.number().int().positive(),
    maxPerDraw: z.number().int(),
    dailyLimitCount: z.number().int(),
    notifyEachDraw: z.boolean(),
  }),
  z.object({
    action: z.literal("suspend"),
    agentId: z.number().int().positive(),
  }),
  z.object({
    action: z.literal("resume"),
    agentId: z.number().int().positive(),
  }),
  z.object({
    action: z.literal("recover"),
    orderId: z.number().int().positive(),
  }),
  z.object({
    action: z.literal("mark-failed"),
    orderId: z.number().int().positive(),
    confirmSuffix: z.string().trim().min(4).max(8),
  }),
  z.object({
    action: z.literal("manual-use"),
    itemId: z.number().int().positive(),
    reason: z.string().trim().min(1).max(200),
  }),
  z.object({
    action: z.literal("void-item"),
    itemId: z.number().int().positive(),
    mode: z.enum(["upstream", "local"]),
    reason: z.string().trim().min(1).max(200),
  }),
  z.object({
    action: z.literal("revert-bill"),
    billId: z.number().int().positive(),
    reason: z.string().trim().min(1).max(200),
  }),
  z.object({
    action: z.literal("reject"),
    applicationId: z.number().int().positive(),
    reason: z.string().trim().min(1).max(200),
  }),
]);

export async function POST(req: Request) {
  const session = await admin();
  if (session instanceof Response) return session;
  await bootDb();
  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "参数无效" }, { status: 400 });
  }
  try {
    const body = parsed.data;
    if (body.action === "settle") {
      const bill = await settleDrawItems(body, session);
      return NextResponse.json({ bill });
    }
    if (body.action === "grant") {
      await grantDrawAccess(body, session);
      return NextResponse.json({ ok: true });
    }
    if (body.action === "credit") {
      const result = await updateDrawCredit(body, session);
      return NextResponse.json({ ok: true, ...result });
    }
    if (body.action === "settings") {
      const result = await updateDrawSettings(body, session);
      return NextResponse.json({ ok: true, ...result });
    }
    if (body.action === "suspend") {
      await suspendDrawAccess(body.agentId, session);
      return NextResponse.json({ ok: true });
    }
    if (body.action === "resume") {
      await resumeDrawAccess(body.agentId, session);
      return NextResponse.json({ ok: true });
    }
    if (body.action === "recover") {
      const order = await recoverDrawOrder(body.orderId, session);
      return NextResponse.json({ ok: true, order });
    }
    if (body.action === "mark-failed") {
      await markDrawOrderFailed(body.orderId, body.confirmSuffix, session);
      return NextResponse.json({ ok: true });
    }
    if (body.action === "manual-use") {
      await manualUseDrawItem(body, session);
      return NextResponse.json({ ok: true });
    }
    if (body.action === "void-item") {
      await voidDrawItem(body, session);
      return NextResponse.json({ ok: true });
    }
    if (body.action === "revert-bill") {
      await revertDrawBill(body, session);
      return NextResponse.json({ ok: true });
    }
    await rejectDrawApplication(body, session);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const status = error instanceof DrawError ? error.status : 400;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "操作失败" },
      { status },
    );
  }
}
