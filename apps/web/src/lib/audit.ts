import { db } from "@/db";
import { auditLogs } from "@/db/schema";
import type { AuthSession } from "@/lib/auth";

export async function writeAuditLog(input: {
  actor?: Pick<AuthSession, "id" | "role"> | null;
  action: string;
  targetType: string;
  targetId?: string | number;
  metadata?: Record<string, unknown>;
  ip?: string;
}) {
  await db.insert(auditLogs).values({
    actorUserId: input.actor?.id ?? null,
    actorRole: input.actor?.role ?? "system",
    action: input.action,
    targetType: input.targetType,
    targetId: String(input.targetId ?? ""),
    metadataJson: JSON.stringify(input.metadata ?? {}),
    ip: input.ip?.trim() ?? "",
  });
}
