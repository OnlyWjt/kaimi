import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { paymentChannelConfigs } from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { bootDb, getSetting, setSetting } from "@/lib/config";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

const schema = z.object({
  apiBase: z.string().trim().url(),
  pid: z.string().trim().min(1).max(64),
  key: z.string().trim().max(256).optional(),
  signMode: z.enum(["append", "key_param"]).default("append"),
  channels: z.object({
    alipay: z.object({
      enabled: z.boolean(),
      feeRatePpm: z.number().int().min(0).max(1_000_000),
      fixedFeeCents: z.number().int().min(0),
    }),
    wxpay: z.object({
      enabled: z.boolean(),
      feeRatePpm: z.number().int().min(0).max(1_000_000),
      fixedFeeCents: z.number().int().min(0),
    }),
  }),
});

async function authorize() {
  try {
    return { session: await requireAdmin(), denied: null };
  } catch (error) {
    if (error instanceof Response) return { session: null, denied: error };
    throw error;
  }
}

export async function GET() {
  const { denied } = await authorize();
  if (denied) return denied;
  await bootDb();
  const [apiBase, pid, storedKey, signMode, channels] = await Promise.all([
    getSetting("epay_api_base", ""),
    getSetting("epay_pid", ""),
    getSetting("epay_key", ""),
    getSetting("epay_sign_mode", "append"),
    db.query.paymentChannelConfigs.findMany(),
  ]);
  const key = decryptSecret(storedKey);
  return NextResponse.json({
    apiBase,
    pid,
    signMode,
    keyConfigured: Boolean(key),
    keyHint: key ? `${key.slice(0, 3)}…${key.slice(-3)}` : "",
    channels,
  });
}

export async function POST(req: Request) {
  const { session, denied } = await authorize();
  if (denied || !session) return denied;
  await bootDb();
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;
  await setSetting("epay_api_base", data.apiBase.replace(/\/+$/, ""));
  await setSetting("epay_pid", data.pid);
  await setSetting("epay_sign_mode", data.signMode);
  if (data.key) await setSetting("epay_key", encryptSecret(data.key));

  const now = new Date().toISOString();
  for (const channel of ["alipay", "wxpay"] as const) {
    const values = data.channels[channel];
    await db
      .update(paymentChannelConfigs)
      .set({ ...values, updatedAt: now })
      .where(eq(paymentChannelConfigs.channel, channel));
  }
  await writeAuditLog({
    actor: session,
    action: "admin.payment.update",
    targetType: "payment_config",
    metadata: { pid: data.pid, apiBase: data.apiBase },
  });
  return NextResponse.json({ ok: true });
}
