import { and, desc, eq, lt, ne, notLike, or } from "drizzle-orm";
import { db } from "@/db";
import { issuedCdks, storeOrders } from "@/db/schema";
import { decryptSecret, maskCode } from "@/lib/crypto";
import { isApiKeyContext, requireApiKey } from "@/lib/open-api/auth";
import { loadRegionPlans, openRegion } from "@/lib/open-api/cdk-region";
import { openOk } from "@/lib/open-api/respond";

export async function GET(req: Request) {
  const auth = await requireApiKey(req, "cdks:read");
  if (!isApiKeyContext(auth)) return auth;
  const url = new URL(req.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || "20") || 20));
  const cursor = Number(url.searchParams.get("cursor") || 0);
  // 提卡领走的成品号也记在 issued_cdks 里，但它不是卡密，不在这里列。
  const filters = [or(ne(issuedCdks.source, "draw"), notLike(issuedCdks.upstreamRef, "finished:%"))];
  if (auth.ownerType === "agent") {
    if (!auth.agentId) return openOk({ cdks: [], page: { next_cursor: null, has_more: false } });
    filters.push(eq(issuedCdks.agentId, auth.agentId));
  }
  if (Number.isSafeInteger(cursor) && cursor > 0) filters.push(lt(issuedCdks.id, cursor));
  const status = url.searchParams.get("status")?.trim();
  if (status) filters.push(eq(issuedCdks.status, status));
  // 提卡来的卡没有商城订单（order_id = 0），带 order_no 过滤时自然只剩商城卖的卡。
  const orderNo = url.searchParams.get("order_no")?.trim();
  if (orderNo) filters.push(eq(storeOrders.orderNo, orderNo));
  const rows = await db
    .select({
      id: issuedCdks.id,
      status: issuedCdks.status,
      source: issuedCdks.source,
      planKey: issuedCdks.planKey,
      paymentCountry: issuedCdks.paymentCountry,
      codeEncrypted: issuedCdks.codeEncrypted,
      orderNo: storeOrders.orderNo,
      issuedAt: issuedCdks.issuedAt,
      usedAt: issuedCdks.usedAt,
    })
    .from(issuedCdks)
    .leftJoin(storeOrders, eq(storeOrders.id, issuedCdks.orderId))
    .where(and(...filters))
    .orderBy(desc(issuedCdks.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const plans = await loadRegionPlans(page.map((row) => row.planKey));
  return openOk({
    cdks: page.map((row) => {
      let masked = "";
      try {
        masked = maskCode(decryptSecret(row.codeEncrypted));
      } catch {
        masked = "";
      }
      return {
        id: row.id,
        status: row.status,
        source: row.source,
        plan_key: row.planKey,
        payment_country: row.paymentCountry,
        region: openRegion(row.paymentCountry, plans.get(row.planKey)),
        order_no: row.orderNo,
        code_masked: masked,
        issued_at: row.issuedAt,
        used_at: row.usedAt,
      };
    }),
    page: { next_cursor: hasMore && last ? String(last.id) : null, has_more: hasMore },
  });
}
