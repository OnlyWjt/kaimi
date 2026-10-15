import { after, NextResponse } from "next/server";
import { z } from "zod";
import { enforceBatchRateLimit } from "@/lib/batch-rate-limit";
import { getBatchRedeemLimit } from "@/lib/batch-redeem-limit";
import { sanitizeLog } from "@/lib/log";
import {
  openRechargeOrder,
  RedeemInFlightError,
  type OpenedRechargeOrder,
} from "@/lib/orders";
import { driveRechargeBatch } from "@/lib/recharge-batch";
import { clampRedeemCodes } from "@/lib/recharge-batch-core";
import {
  ANON_BATCH_CODES_PER_REQUEST,
  BATCH_STOPPED_MESSAGE,
  createBatchGuessGuard,
} from "@/lib/redeem-guard-core";
import { assertBatchCodeBudget, recordRedeemFailure } from "@/lib/redeem-guard";
import { RedeemRejectedError } from "@/lib/redeem-guard-core";
import { getSession } from "@/lib/auth";
import { clientIp } from "@/lib/rate-limit";
import { MAILBOX_REDEEM_REMOVED, type AgentCredential } from "@/lib/recharge-types";
import { checkChatGPTSessionLocal } from "@/lib/session-check";
import { publicErrorMessage } from "@/lib/public-error";

const schema = z
  .object({
    codes: z.array(z.string()).min(1).max(200),
    email: z.string().email().optional().or(z.literal("")),
    mode: z.string().optional().default("session"),
    session: z.string().optional().default(""),
  })
  .superRefine((val, ctx) => {
    // mode 不对在 POST 里单独回话术，这里只核 Session。
    if (val.mode === "session" && (!val.session || val.session.trim().length < 8)) {
      ctx.addIssue({ code: "custom", path: ["session"], message: "请填写 Session" });
    }
  });

export async function POST(req: Request) {
  const limited = await enforceBatchRateLimit(req, "recharge-batch-submit", {
    anonymous: 6,
    agent: 20,
  });
  if (limited) return limited;

  try {
    const body = schema.parse(await req.json());
    if (body.mode !== "session") {
      return NextResponse.json({ error: MAILBOX_REDEEM_REMOVED }, { status: 400 });
    }
    const session = await getSession().catch(() => null);
    const anonymous = !(session?.role === "agent" && session.agentId);
    const ip = clientIp(req);
    const cap = anonymous
      ? Math.min(await getBatchRedeemLimit(), ANON_BATCH_CODES_PER_REQUEST)
      : await getBatchRedeemLimit();
    const { codes } = clampRedeemCodes(body.codes, cap);
    const budget = await assertBatchCodeBudget({
      ip,
      agentId: session?.agentId ?? undefined,
      incoming: codes.length,
      anonymous,
    });
    if (budget) return budget;
    if (!codes.length) {
      return NextResponse.json({ error: "请填写要兑换的卡密" }, { status: 400 });
    }

    // 这里只做本地格式校验。整批开跑前多打一次卡台预检，等于白烧一张卡的
    // preview + preflight；每张卡提交时都会自己预检，Session 不对会逐行报出来。
    const local = checkChatGPTSessionLocal(body.session);
    if (!local.ok) {
      return NextResponse.json(
        { error: local.errors[0] || "Session 无效", errors: local.errors },
        { status: 400 },
      );
    }
    const contactEmail = (local.email || body.email || "").trim();
    if (!contactEmail) {
      return NextResponse.json(
        { error: "Session 中未读到邮箱，请更换账号后再试" },
        { status: 400 },
      );
    }
    const account: AgentCredential = {
      mode: "session",
      session: body.session.trim(),
      email: contactEmail,
    };

    // 建单是纯本地写库，逐张串行做完就把单号还给前端；上游那串慢调用交给 after()。
    const guesses = createBatchGuessGuard();
    const pending: Array<{ opened: OpenedRechargeOrder; code: string }> = [];
    const list: Array<{
      code: string;
      ok: boolean;
      orderNo: string;
      error: string;
    }> = [];
    for (const code of codes) {
      try {
        if (guesses.stopped) {
          list.push({ code, ok: false, orderNo: "", error: BATCH_STOPPED_MESSAGE });
          continue;
        }
        const opened = await openRechargeOrder({
          code,
          email: contactEmail,
          account,
          clientIp: ip,
        });
        pending.push({ opened, code });
        list.push({ code, ok: true, orderNo: opened.order.orderNo, error: "" });
      } catch (error) {
        if (error instanceof RedeemRejectedError) {
          guesses.reject(error.outcome);
          await recordRedeemFailure({
            ip,
            email: contactEmail,
            outcome: error.outcome,
            route: "recharge-batch-submit",
          });
        }
        list.push({
          code,
          ok: false,
          orderNo: error instanceof RedeemInFlightError ? error.orderNo : "",
          error: publicErrorMessage(error, "兑换订单创建失败", "recharge/batch/submit"),
        });
      }
    }

    if (pending.length) {
      after(async () => {
        await driveRechargeBatch(pending, account).catch((error) => {
          console.error(
            "[kaimi] batch redeem drive failed",
            sanitizeLog(error instanceof Error ? error.message : "unknown error"),
          );
        });
      });
    }

    return NextResponse.json({ ok: true, list });
  } catch (error) {
    const message = publicErrorMessage(error, "提交失败", "recharge/batch/submit");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
