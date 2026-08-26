import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { storefronts } from "@/db/schema";
import { bootDb } from "@/lib/config";

export async function GET(req: Request) {
  await bootDb();
  const kind = new URL(req.url).searchParams.get("kind") || "shop";
  const row = await db.query.storefronts.findFirst({
    where: eq(storefronts.kind, kind),
  });
  return NextResponse.json({ storefront: row });
}
