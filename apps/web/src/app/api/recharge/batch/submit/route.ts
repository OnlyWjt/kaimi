import { after, NextResponse } from "next/server";
import { z } from "zod";
import { enforceBatchRateLimit } from "@/lib/batch-rate-limit";
import { getBatchRedeemLimit } from "@/lib/batch-redeem-limit";
import { sanitizeLog } from "@/lib/log";
import { openRechargeOrder, type OpenedRechargeOrder } from "@/lib/orders";
import { driveRechargeBatch } from "@/lib/recharge-batch";
import { clampRedeemCodes } from "@/lib/recharge-batch-core";
import type { AgentCredential } from "@/lib/recharge-types";
import { checkChatGPTSessionLocal } from "@/lib/session-check";

const schema = z
  .object({
    codes: z.array(z.string()).min(1).max(200),
    email: z.string().email().optional().or(z.literal("")),
    mode: z.enum(["session", "mailbox"]).optional().default("session"),
    session: z.string().optional().default(""),
    password: z.string().optional().default(""),
  })
  .superRefine((val, ctx) => {
    if (val.mode === "mailbox") {
      if (!val.password || val.password.length < 4) {
        ctx.addIssue({ code: "custom", path: ["password"], message: "请填写邮箱密码" });
      }
    } else if (!val.session || val.session.trim().length < 8) {
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
    const { codes } = clampRedeemCodes(body.codes, await getBatchRedeemLimit());
    if (!codes.length) {
      return NextResponse.json({ error: "请填写要兑换的卡密" }, { status: 400 });
    }

    let account: AgentCredential;
    let contactEmail: string;
    if (body.mode === "mailbox") {
      contactEmail = String(body.email || "").trim();
      if (!contactEmail) {
        return NextResponse.json({ error: "请填写账号邮箱" }, { status: 400 });
      }
      account = {
        mode: "mailbox",
        email: contactEmail,
        password: body.password.trim(),
        email_password: body.password.trim(),
      };
    } else {
      // 这里只做本地格式校验。整批开跑前多打一次卡台预检，等于白烧一张卡的
      // preview + preflight；每张卡提交时都会自己预检，Session 不对会逐行报出来。
      const local = checkChatGPTSessionLocal(body.session);
      if (!local.ok) {
        return NextResponse.json(
          { error: local.errors[0] || "Session 无效", errors: local.errors },
          { status: 400 },
        );
      }
      contactEmail = (local.email || body.email || "").trim();
      if (!contactEmail) {
        return NextResponse.json(
          { error: "Session 中未读到邮箱，请更换账号后再试" },
          { status: 400 },
        );
      }
      account = {
        mode: "session",
        session: body.session.trim(),
        email: contactEmail,
      };
    }

    // 建单是纯本地写库，逐张串行做完就把单号还给前端；上游那串慢调用交给 after()。
    const pending: Array<{ opened: OpenedRechargeOrder; code: string }> = [];
    const list: Array<{
      code: string;
      ok: boolean;
      orderNo: string;
      error: string;
    }> = [];
    for (const code of codes) {
      try {
        const opened = await openRechargeOrder({
          code,
          email: contactEmail,
          account,
        });
        pending.push({ opened, code });
        list.push({ code, ok: true, orderNo: opened.order.orderNo, error: "" });
      } catch (error) {
        list.push({
          code,
          ok: false,
          orderNo: "",
          error: error instanceof Error ? error.message : "兑换订单创建失败",
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
    const message = error instanceof Error ? error.message : "提交失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
