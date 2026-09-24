import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "@/db";
import { issuedCdks, storeOrders } from "@/db/schema";
import { decryptSecret, maskCode } from "@/lib/crypto";
import { isApiKeyContext, requireApiKey } from "@/lib/open-api/auth";
import { openOk } from "@/lib/open-api/respond";

export async function GET(req: Request) {
  const auth = await requireApiKey(req, "cdks:read");
  if (!isApiKeyContext(auth)) return auth;
  const url = new URL(req.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || "20") || 20));
  const cursor = Number(url.searchParams.get("cursor") || 0);
  const filters = [];
  if (auth.ownerType === "agent") {
    if (!auth.agentId) return openOk({ cdks: [], page: { next_cursor: null, has_more: false } });
    filters.push(eq(issuedCdks.agentId, auth.agentId));
  }
  if (Number.isSafeInteger(cursor) && cursor > 0) filters.push(lt(issuedCdks.id, cursor));
  const status = url.searchParams.get("status")?.trim();
  if (status) filters.push(eq(issuedCdks.status, status));
  const orderNo = url.searchParams.get("order_no")?.trim();
  if (orderNo) filters.push(eq(storeOrders.orderNo, orderNo));
  const rows = await db
    .select({
      id: issuedCdks.id,
      status: issuedCdks.status,
      planKey: issuedCdks.planKey,
      codeEncrypted: issuedCdks.codeEncrypted,
      orderNo: storeOrders.orderNo,
      issuedAt: issuedCdks.issuedAt,
      usedAt: issuedCdks.usedAt,
    })
    .from(issuedCdks)
    .innerJoin(storeOrders, eq(storeOrders.id, issuedCdks.orderId))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(issuedCdks.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
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
        plan_key: row.planKey,
        order_no: row.orderNo,
        code_masked: masked,
        issued_at: row.issuedAt,
        used_at: row.usedAt,
      };
    }),
    page: { next_cursor: hasMore && last ? String(last.id) : null, has_more: hasMore },
  });
}
