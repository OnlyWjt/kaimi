import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { DrawError, revealDrawItemCode } from "@/lib/agent-draw";
import { isApiKeyContext, requireApiKey } from "@/lib/open-api/auth";
import { agentDrawAccessStatus } from "@/lib/open-api/draw-access";
import { openFail, openOk } from "@/lib/open-api/respond";

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireApiKey(req, "draw:reveal");
  if (!isApiKeyContext(auth)) return auth;
  if (auth.ownerType !== "agent" || !auth.agentId) {
    return openFail("FORBIDDEN_SCOPE", "只有代理 Key 可以看提卡明文");
  }
  const status = await agentDrawAccessStatus(auth.agentId);
  if (status !== "approved" && status !== "suspended") {
    return openFail("FORBIDDEN_SCOPE", "还没有提卡权限");
  }
  const itemId = Number((await context.params).id);
  if (!Number.isSafeInteger(itemId) || itemId <= 0) return openFail("NOT_FOUND", "卡密不存在");
  const user = await db.query.users.findFirst({
    where: eq(users.agentId, auth.agentId),
    columns: { id: true },
  });
  try {
    const revealed = await revealDrawItemCode(itemId, { id: user?.id ?? 0, role: "agent" }, auth.agentId);
    return openOk({ id: revealed.id, code: revealed.code });
  } catch (error) {
    if (error instanceof DrawError && error.status === 404) return openFail("NOT_FOUND", error.message);
    return openFail("VALIDATION_FAILED", error instanceof Error ? error.message : "查看失败");
  }
}
