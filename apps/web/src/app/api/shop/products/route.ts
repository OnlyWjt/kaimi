import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { products } from "@/db/schema";
import { bootDb } from "@/lib/config";
import { countUnused } from "@/lib/inventory";
import { centsToYuan } from "@/lib/crypto";
import { enforceRateLimit } from "@/lib/rate-limit";
import { isShopEnabled } from "@/lib/storefront";

export async function GET(req: Request) {
  const limited = enforceRateLimit(req, "shop-products", 60);
  if (limited) return limited;
  await bootDb();
  const { searchParams } = new URL(req.url);
  const kind = searchParams.get("kind");
  if (kind !== "recharge" && !(await isShopEnabled())) {
    return NextResponse.json({ list: [], shopEnabled: false });
  }

  const list = await db.query.products.findMany({
    where: kind ? eq(products.kind, kind) : undefined,
    orderBy: [asc(products.sortOrder), asc(products.id)],
  });

  const publicList = [];
  for (const p of list.filter((x) => x.enabled)) {
    const stock = await countUnused(p.upstreamPlan);
    publicList.push({
      id: p.id,
      kind: p.kind,
      title: p.title,
      coverUrl: p.coverUrl,
      descriptionHtml: p.descriptionHtml,
      price: centsToYuan(p.priceCents),
      currency: p.currency,
      upstreamPlan: p.upstreamPlan,
      stockVisible: p.stockVisible,
      stock: p.stockVisible ? stock : null,
    });
  }

  return NextResponse.json({ list: publicList });
}
