import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { normalizeAgentSlug } from "@/lib/agent-slug";
import { bootDb } from "@/lib/config";
import { enforceRateLimit } from "@/lib/rate-limit";
import { referralCodeValid } from "@/lib/referrals";

/** 结账页手填邀请码：只回对不对，不透露是谁的。?slug=onlywjt&code=K7M2QX */
export async function GET(req: Request) {
  const limited = enforceRateLimit(req, "public-referral-code", 20);
  if (limited) return limited;
  await bootDb();
  const search = new URL(req.url).searchParams;
  const slug = (search.get("slug") || "").trim();
  const code = (search.get("code") || "").trim();
  if (!slug || !code) return NextResponse.json({ valid: false });
  const agent = await db.query.agents.findFirst({
    where: and(eq(agents.currentSlug, normalizeAgentSlug(slug)), eq(agents.status, "active")),
    columns: { id: true },
  });
  if (!agent) return NextResponse.json({ valid: false });
  return NextResponse.json({ valid: await referralCodeValid(agent.id, code) });
}
