import { getSession } from "@/lib/auth";
import { enforceRateLimit, enforceRateLimitFor } from "@/lib/rate-limit";

/**
 * 批量接口的额度：一次用户操作只花一个额度。
 *
 * 从浏览器循环调单张接口是行不通的——20 张卡正好把 recharge-validate 的 20/min
 * 打满，recharge-submit 的 8/min 更是立刻见底，客户会在批量跑到一半时吃到
 * 「请求过于频繁，请稍后再试」。所以校验、提交、每轮进度各收成一次调用。
 *
 * 代理是登录用户，按代理身份计额度而不是按出口 IP，额度也给得宽一些。
 */
export async function enforceBatchRateLimit(
  req: Request,
  name: string,
  limits: { anonymous: number; agent: number },
) {
  const session = await getSession().catch(() => null);
  if (session?.role === "agent" && session.agentId) {
    return enforceRateLimitFor(
      `${name}:agent:${session.agentId}`,
      limits.agent,
    );
  }
  return enforceRateLimit(req, name, limits.anonymous);
}
