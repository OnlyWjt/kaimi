import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agentDrawAccess } from "@/db/schema";

export async function agentDrawAccessStatus(agentId: number) {
  const access = await db.query.agentDrawAccess.findFirst({
    where: eq(agentDrawAccess.agentId, agentId),
    columns: { status: true },
  });
  return access?.status || "none";
}

/** 申请已通过（含后来被暂停）才给看提卡文档和权限勾选。 */
export async function agentCanSeeDrawApi(agentId: number) {
  const status = await agentDrawAccessStatus(agentId);
  return status === "approved" || status === "suspended";
}
