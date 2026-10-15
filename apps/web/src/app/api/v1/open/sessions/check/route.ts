import { z } from "zod";
import { findIssuedCdkByCode } from "@/lib/cardplatform/issued-redemption";
import { isApiKeyContext, requireApiKey } from "@/lib/open-api/auth";
import { openFail, openOk } from "@/lib/open-api/respond";
import { sessionCheckPayload } from "@/lib/open-api/session-check-core";
import { recordRedeemFailure, redeemBlockResponse } from "@/lib/redeem-guard";
import { verifySessionForRedeem } from "@/lib/session-check";
import { REDEEM_CODE_MIN_LENGTH } from "@/lib/redeem-code";

const schema = z.object({
  session: z.string().min(1).max(50_000),
  code: z.string().trim().min(REDEEM_CODE_MIN_LENGTH).max(64),
});

/**
 * 兑换前校验买家的 Session：转发卡台兑换预检，和店铺兑换页的「校验 Session」是同一个检查。
 * 权限 redeem:write。预检不消耗卡密，也不会开通。
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
  if (!parsed.success) return openFail("VALIDATION_FAILED", "请传 session 和要兑换的卡密 code");
  const { session, code } = parsed.data;

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
  return openOk(sessionCheckPayload(await verifySessionForRedeem(session, code)));
}
