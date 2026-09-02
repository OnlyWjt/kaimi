import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { cardplatformAccounts } from "@/db/schema";
import { authorizeAdmin } from "@/lib/admin-guard";
import { getCardplatformAccountOrThrow } from "@/lib/cardplatform/accounts";
import { CardplatformError } from "@/lib/cardplatform/client";
import { getCardplatformClientById } from "@/lib/cardplatform/config";
import { bootDb } from "@/lib/config";
import { detectEgressIp } from "@/lib/network/egress";

const schema = z.object({
  mode: z.enum(["connect", "price", "balance", "all"]).default("all"),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authorizeAdmin();
  if (auth.error) return auth.error;
  await bootDb();
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return NextResponse.json({ error: "无效账户" }, { status: 400 });
  }
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  const mode = parsed.success ? parsed.data.mode : "all";
  try {
    const account = await getCardplatformAccountOrThrow(id);
    const { client } = await getCardplatformClientById(id, {
      allowDisabled: true,
    });
    const now = new Date().toISOString();
    const result: Record<string, unknown> = {
      accountId: id,
      name: account.name,
      siteBase: account.siteBase,
    };
    if (mode === "connect" || mode === "all") {
      const ping = await pingHost(account.siteBase, client);
      result.connect = ping;
      if (!ping.ok) {
        const message = String(ping.message || ping.error || "连通失败");
        await markError(id, String(ping.error || message), now);
        return NextResponse.json(
          { ok: false, error: message, ...result },
          { status: 502 },
        );
      }
    }
    if (mode === "balance" || mode === "all") {
      const balance = await client.getBalance(12_000);
      result.balance = balance;
      result.spendableCents = balance.spendableCents;
    }
    if (mode === "price" || mode === "all") {
      const plans = await client.getPlans(12_000);
      result.plans = plans.length;
    }
    await db
      .update(cardplatformAccounts)
      .set({
        lastHealthAt: now,
        lastOkAt: now,
        lastError: "",
        updatedAt: now,
      })
      .where(eq(cardplatformAccounts.id, id));
    result.egress = await detectEgressIp();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const now = new Date().toISOString();
    const message = error instanceof Error ? error.message : "探测失败";
    await markError(id, message, now);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}

async function markError(id: number, message: string, now: string) {
  await db
    .update(cardplatformAccounts)
    .set({
      lastError: message.slice(0, 500),
      lastErrorAt: now,
      lastHealthAt: now,
      updatedAt: now,
    })
    .where(eq(cardplatformAccounts.id, id));
}

async function pingHost(
  siteBase: string,
  client: { getBalance: (timeoutMs?: number) => Promise<unknown> },
) {
  try {
    await client.getBalance(12_000);
    return { ok: true, message: "连通", status: 200 };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unreachable";
    const status =
      error instanceof CardplatformError
        ? error.httpStatus
        : /401/.test(message)
          ? 401
          : /403/.test(message)
            ? 403
            : 0;
    return {
      ok: status > 0 && status < 500 && status !== 401 && status !== 403,
      message:
        status === 401
          ? "主机可达；API Key 无效（401）"
          : status === 403
            ? "主机可达；当前 IP 不在卡台白名单（403）"
            : message,
      error: message,
      status,
      siteBase,
    };
  }
}
