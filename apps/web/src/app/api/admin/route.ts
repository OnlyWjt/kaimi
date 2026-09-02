import { NextResponse } from "next/server";
import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { db } from "@/db";
import { cdkPool, orders, storefronts } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { bootDb, getAppConfig, getSetting, setSetting } from "@/lib/config";
import { decryptSecret, encryptSecret, maskCode } from "@/lib/crypto";
import {
  countByStatus,
  countUnused,
  disableCode,
  enableCode,
  voidCode,
} from "@/lib/inventory";
import {
  countInFlightRecharges,
  getStatusHistory,
  pollInFlightOrders,
  pollRechargeByRequestId,
  pollRechargeIfNeeded,
  reconcileStuckLocks,
} from "@/lib/orders";
import { getDefaultCardplatformAccount } from "@/lib/cardplatform/config";

async function guard() {
  try {
    return await requireAdmin();
  } catch (res) {
    if (res instanceof Response) return res;
    throw res;
  }
}

function publicBaseFromReq(req: Request) {
  const env = process.env.KAIMI_PUBLIC_BASE_URL?.replace(/\/+$/, "");
  if (env) return env;
  const proto = req.headers.get("x-forwarded-proto") || "http";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "localhost:3100";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function maskKey(key: string) {
  const plain = decryptSecret(key);
  if (!plain) return "";
  if (plain.length <= 10) return "••••";
  return `${plain.slice(0, 8)}…${plain.slice(-4)}`;
}

export async function GET(req: Request) {
  const auth = await guard();
  if (auth instanceof Response) return auth;
  await bootDb();

  const { searchParams } = new URL(req.url);
  const section = searchParams.get("section") || "overview";

  if (section === "overview") {
    const cfg = await getAppConfig();
    const stock = await countByStatus();
    const orderCount = await db
      .select({ c: sql<number>`count(*)` })
      .from(orders)
      .then((r) => Number(r[0]?.c ?? 0));
    const recentOrders = await db.query.orders.findMany({
      orderBy: [desc(orders.id)],
      limit: 12,
    });
    const inflightCount = await countInFlightRecharges();
    const cardAccount = await getDefaultCardplatformAccount();
    return NextResponse.json({
      setupCompleted: cfg.setupCompleted,
      paymentMode: cfg.paymentMode,
      hasCardplatform: Boolean(cardAccount),
      cardplatformSiteBase: cardAccount?.siteBase || "",
      unusedStock: stock.unused ?? 0,
      lockedCount: stock.locked ?? 0,
      inflightCount,
      stock,
      orderCount,
      recentOrders: recentOrders.map((o) => ({
        orderNo: o.orderNo,
        kind: o.kind,
        email: o.email,
        payStatus: o.payStatus,
        fulfillStatus: o.fulfillStatus,
        upstreamPlan: o.upstreamPlan,
        message: o.message,
        createdAt: o.createdAt,
      })),
    });
  }

  if (section === "orders") {
    const status = searchParams.get("status") || "";
    const q = searchParams.get("q")?.trim() || "";
    const list = await db.query.orders.findMany({
      orderBy: [desc(orders.id)],
      limit: 200,
    });
    const allCdk = list.length
      ? await db
          .select({ orderId: cdkPool.orderId, code: cdkPool.code })
          .from(cdkPool)
          .where(
            inArray(
              cdkPool.orderId,
              list.map((o) => o.id),
            ),
          )
      : [];
    const codeByOrder = new Map<number, string>();
    for (const row of allCdk) {
      if (row.orderId) codeByOrder.set(row.orderId, row.code);
    }
    const filtered = list.filter((o) => {
      if (status && o.fulfillStatus !== status && o.payStatus !== status) return false;
      if (!q) return true;
      const raw = codeByOrder.get(o.id) || "";
      const hay = `${o.orderNo} ${o.email} ${o.accountEmail || ""} ${o.upstreamRequestId || ""} ${raw} ${raw.slice(-4)}`.toLowerCase();
      return hay.includes(q.toLowerCase());
    });

    if (searchParams.get("export") === "csv") {
      const header = [
        "order_no",
        "kind",
        "email",
        "plan",
        "pay_status",
        "fulfill_status",
        "request_id",
        "message",
        "created_at",
      ];
      const lines = [
        header.join(","),
        ...filtered.map((o) =>
          [
            o.orderNo,
            o.kind,
            o.email,
            o.upstreamPlan,
            o.payStatus,
            o.fulfillStatus,
            o.upstreamRequestId || "",
            (o.message || "").replace(/"/g, '""'),
            o.createdAt,
          ]
            .map((v) => `"${String(v ?? "")}"`)
            .join(","),
        ),
      ];
      return new NextResponse(lines.join("\n"), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="kaimi-orders.csv"',
        },
      });
    }

    return NextResponse.json({
      list: filtered.map((o) => {
        const raw = codeByOrder.get(o.id) || "";
        return {
          ...o,
          codeMasked: raw ? maskCode(raw) : "",
          codeLast4: raw ? raw.slice(-4) : "",
        };
      }),
      total: filtered.length,
    });
  }

  if (section === "stock" || section === "cdks") {
    const status = searchParams.get("status") || "";
    const q = searchParams.get("q")?.trim() || "";
    const page = Math.max(1, Number(searchParams.get("page") || "1") || 1);
    const pageSize = Math.min(100, Math.max(1, Number(searchParams.get("page_size") || "20") || 20));
    const conditions = [];
    if (status) conditions.push(eq(cdkPool.status, status));
    if (q) conditions.push(like(cdkPool.code, `%${q}%`));
    const where = conditions.length ? and(...conditions) : undefined;

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)` })
      .from(cdkPool)
      .where(where);

    const list = await db.query.cdkPool.findMany({
      where,
      orderBy: [desc(cdkPool.id)],
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    return NextResponse.json({
      list: list.map((c) => ({
        id: c.id,
        planKey: c.planKey,
        status: c.status,
        codeMasked: maskCode(c.code),
        orderId: c.orderId,
        source: c.source,
        lockedAt: c.lockedAt,
        soldAt: c.soldAt,
        usedAt: c.usedAt,
        updatedAt: c.updatedAt,
      })),
      page,
      page_size: pageSize,
      total: Number(total) || 0,
      unused: await countUnused(),
    });
  }

  if (section === "integration") {
    const cfg = await getAppConfig();
    const publicBase = (await getSetting("public_base_url")) || publicBaseFromReq(req);
    const syncIntervalMinutes = Number(await getSetting("sync_interval_minutes", "15")) || 0;
    const syncLastAt = await getSetting("sync_last_at", "");
    const syncLastRaw = await getSetting("sync_last_result", "");
    let syncLastResult = "";
    try {
      const parsed = syncLastRaw ? JSON.parse(syncLastRaw) : null;
      if (parsed?.plans || parsed?.stock) {
        syncLastResult = `套餐 ${parsed.plans?.upserted ?? 0} · 库存+${parsed.stock?.imported ?? 0}/禁用${parsed.stock?.disabled ?? 0}`;
      }
    } catch {
      syncLastResult = "";
    }
    const cardAccount = await getDefaultCardplatformAccount();
    return NextResponse.json({
      publicBaseUrl: publicBase.replace(/\/+$/, ""),
      setupCompleted: cfg.setupCompleted,
      paymentMode: "manual",
      hasCardplatform: Boolean(cardAccount),
      cardplatformSiteBase: cardAccount?.siteBase || "",
      syncIntervalMinutes,
      syncLastAt,
      syncLastResult,
      notifyWebhookUrl: await getSetting("notify_webhook_url", ""),
      telegramBotTokenHint: maskKey(await getSetting("telegram_bot_token", "")),
      telegramBotTokenConfigured: Boolean(await getSetting("telegram_bot_token", "")),
      telegramChatId: await getSetting("telegram_chat_id", ""),
    });
  }

  if (section === "appearance" || section === "storefronts") {
    const list = await db.query.storefronts.findMany();
    const siteTheme = await getSetting("site_theme", "snow");
    const siteName = await getSetting("site_name", "Kaimi");
    const buyCdkUrl = await getSetting("buy_cdk_url", "");
    const shopEnabled = (await getSetting("shop_enabled", "0")) === "1";
    return NextResponse.json({ list, siteTheme, siteName, buyCdkUrl, shopEnabled });
  }

  if (section === "plans") {
    return NextResponse.json(
      { error: "请到「接入卡台」同步卡台套餐", ok: false },
      { status: 410 },
    );
  }

  return NextResponse.json({ error: "unknown section" }, { status: 400 });
}

export async function POST(req: Request) {
  const auth = await guard();
  if (auth instanceof Response) return auth;
  await bootDb();

  const body = await req.json();
  const action = String(body.action || "");

  if (action === "save_integration" || action === "save_settings") {
    if (body.publicBaseUrl) {
      await setSetting("public_base_url", String(body.publicBaseUrl).replace(/\/+$/, ""));
    }
    if (body.paymentMode) {
      await setSetting("payment_mode", "manual");
    }
    if (body.syncIntervalMinutes !== undefined && body.syncIntervalMinutes !== null) {
      const n = Math.max(0, Math.min(1440, Math.floor(Number(body.syncIntervalMinutes) || 0)));
      await setSetting("sync_interval_minutes", String(n));
    }
    if (body.notifyWebhookUrl !== undefined) {
      await setSetting("notify_webhook_url", String(body.notifyWebhookUrl || "").trim());
    }
    if (body.telegramBotToken) {
      await setSetting("telegram_bot_token", encryptSecret(String(body.telegramBotToken).trim()));
    }
    if (body.telegramChatId !== undefined) {
      await setSetting("telegram_chat_id", String(body.telegramChatId || "").trim());
    }
    await setSetting("setup_completed", "1");
    return NextResponse.json({ ok: true });
  }

  if (action === "test_connection" || action === "ping" || action === "sync_stock") {
    return NextResponse.json(
      { ok: false, error: "旧 danewcdk 上游已移除，请到「接入卡台」测试连接并同步套餐" },
      { status: 410 },
    );
  }

  if (action === "reconcile_locks") {
    try {
      const locks = await reconcileStuckLocks();
      return NextResponse.json({ ok: true, ...locks });
    } catch (err) {
      return NextResponse.json(
        { ok: false, error: err instanceof Error ? err.message : "对账失败" },
        { status: 500 },
      );
    }
  }

  if (action === "sync_plans") {
    return NextResponse.json(
      { ok: false, error: "请使用「接入卡台」里的测试连接并同步套餐" },
      { status: 410 },
    );
  }

  if (action === "void_cdk") {
    try {
      const row = await voidCode(Number(body.id));
      return NextResponse.json({ ok: true, status: row.status });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "核销失败" },
        { status: 400 },
      );
    }
  }

  if (action === "disable_cdk") {
    try {
      const row = await disableCode(Number(body.id));
      return NextResponse.json({ ok: true, status: row.status });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "禁用失败" },
        { status: 400 },
      );
    }
  }

  if (action === "reveal_cdk") {
    const row = await db.query.cdkPool.findFirst({ where: eq(cdkPool.id, Number(body.id)) });
    if (!row) return NextResponse.json({ error: "卡密不存在" }, { status: 404 });
    return NextResponse.json({ ok: true, id: row.id, code: row.code });
  }

  if (action === "poll_order") {
    try {
      const orderNo = String(body.orderNo || "").trim();
      const requestId = String(body.requestId || "").trim();
      if (requestId) {
        const list = await pollRechargeByRequestId(requestId);
        return NextResponse.json({ ok: true, list, message: `已按 request_id 重拉 ${list.length} 笔` });
      }
      if (!orderNo) return NextResponse.json({ error: "缺少订单号" }, { status: 400 });
      const order = await pollRechargeIfNeeded(orderNo);
      const history = order ? await getStatusHistory(order.id) : [];
      return NextResponse.json({
        ok: true,
        order,
        history,
        message: order ? `已重拉 ${order.orderNo} → ${order.fulfillStatus}` : "未找到订单",
      });
    } catch (err) {
      return NextResponse.json(
        { ok: false, error: err instanceof Error ? err.message : "重拉失败" },
        { status: 502 },
      );
    }
  }

  if (action === "poll_inflight") {
    try {
      const result = await pollInFlightOrders();
      return NextResponse.json({
        ok: true,
        ...result,
        message: `已轮询 ${result.polled} 笔进行中订单`,
      });
    } catch (err) {
      return NextResponse.json(
        { ok: false, error: err instanceof Error ? err.message : "批量轮询失败" },
        { status: 502 },
      );
    }
  }

  if (action === "create_purchase" || action === "repay_purchase") {
    return NextResponse.json(
      { error: "即时发卡模式已关闭主站进货，请到商务配置使用卡台即时发码" },
      { status: 409 },
    );
  }


  if (action === "enable_cdk") {
    try {
      const row = await enableCode(Number(body.id));
      return NextResponse.json({ ok: true, status: row.status });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "启用失败" },
        { status: 400 },
      );
    }
  }

  if (action === "save_appearance" || action === "save_storefront") {
    // Site-wide brand/theme (admin 整站外观). Do not overwrite when saving a storefront card.
    if (!body.id) {
      if (body.siteTheme) await setSetting("site_theme", String(body.siteTheme));
      if (body.siteName !== undefined && body.siteName !== null) {
        await setSetting("site_name", String(body.siteName));
      }
      if (body.buyCdkUrl !== undefined && body.buyCdkUrl !== null) {
        await setSetting("buy_cdk_url", String(body.buyCdkUrl).trim());
      }
      if (body.shopEnabled !== undefined) {
        await setSetting("shop_enabled", body.shopEnabled ? "1" : "0");
      }
    }

    if (body.id) {
      await db
        .update(storefronts)
        .set({
          siteName: String(body.storefrontName || body.siteName || ""),
          logoUrl: String(body.logoUrl || ""),
          themeId: String(body.themeId || body.siteTheme || "snow"),
          announcement: String(body.announcement || ""),
          contacts: String(body.contacts || ""),
          icp: String(body.icp || ""),
          homeBanner: String(body.homeBanner || ""),
          afterSales: String(body.afterSales || ""),
          enabled: Boolean(body.enabled ?? true),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(storefronts.id, Number(body.id)));
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
