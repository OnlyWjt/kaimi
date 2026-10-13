import { z } from "zod";
import { findIssuedCdkByCode } from "@/lib/cardplatform/issued-redemption";
import { isApiKeyContext, requireApiKey } from "@/lib/open-api/auth";
import { openFail, openOk } from "@/lib/open-api/respond";
import { sessionCheckPayload } from "@/lib/open-api/session-check-core";
import { recordRedeemFailure, redeemBlockResponse } from "@/lib/redeem-guard";
import { checkChatGPTSessionLocal, verifySessionForRedeem } from "@/lib/session-check";

const schema = z.object({
  session: z.string().min(1).max(50_000),
  code: z.string().trim().min(6).max(64).optional(),
});

/**
 * 兑换前校验买家的 Session。权限 redeem:write，和提交兑换同一把 Key。
 *
 * 只传 session：本地看格式，不发外部请求。
 * 带上本店卖出的卡密：再交给卡台按这张卡预检，能确认这个 Session 拿来兑这张卡走得通。
 * 预检不会消耗卡密，也不会开通。
 *
 * 校验没过是正常结果，HTTP 200、data.ok=false；只有参数错、卡密不是本店的才返回错误。
 * Session 里有 accessToken，这里不落库、不写日志。
 */
export async function POST(req: Request) {
  const auth = await requireApiKey(req, "redeem:write");
  if (!isApiKeyContext(auth)) return auth;
  const subject = `key:${auth.id}`;
  // 和提交兑换共用失败计数：拿这个接口猜卡密，一样会被封。
  const blocked = await redeemBlockResponse({ ip: subject });
  if (blocked) return openFail("REDEEM_BLOCKED", "兑换失败过多，请稍后再试");

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return openFail("VALIDATION_FAILED", "请传 session，卡密可选");
  const { session, code } = parsed.data;

  if (!code) {
    return openOk(sessionCheckPayload(checkChatGPTSessionLocal(session), "format"));
  }

  if (auth.ownerType === "agent") {
    const issued = await findIssuedCdkByCode(code);
    if (!issued || issued.agentId !== auth.agentId) {
      await recordRedeemFailure({
        ip: subject,
        outcome: "unknown_code",
        route: "open-session-check",
      });
      return openFail("CDK_INVALID", "卡密无效或不是本店卖出的");
    }
  }
  return openOk(sessionCheckPayload(await verifySessionForRedeem(session, code), "preflight"));
}
