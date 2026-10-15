import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  agentReconciliationBatches,
  agentReconciliationClaims,
  agentReconciliationItems,
  agents,
  auditLogs,
} from "@/db/schema";
import { collectLines, partition, type Line } from "@/lib/reconciliation-lines";

// 对账的只读查询：代理名单、批次详情和明细、明细导出、代理端批次视图。

export async function listReconciliationAgents(query: {
  search: string;
  status: string;
  sort: string;
  cursor: string;
  limit: number;
  cutoffAt: string;
}) {
  const rows = await db
    .select({ id: agents.id, name: agents.displayName, shopName: agents.shopName })
    .from(agents)
    .orderBy(agents.displayName);
  const taggedLines = await collectLines(db, null, query.cutoffAt);
  const batchRows = await db.select().from(agentReconciliationBatches).orderBy(desc(agentReconciliationBatches.id));
  const claimRows = await db
    .select({ agentId: agentReconciliationBatches.agentId })
    .from(agentReconciliationClaims)
    .innerJoin(agentReconciliationBatches, eq(agentReconciliationBatches.id, agentReconciliationClaims.batchId))
    .where(eq(agentReconciliationClaims.claimState, "active"));
  const linesByAgent = new Map<number, Line[]>();
  for (const row of taggedLines) {
    const bucket = linesByAgent.get(row.agentId);
    if (bucket) bucket.push(row.line);
    else linesByAgent.set(row.agentId, [row.line]);
  }
  const batchesByAgent = new Map<number, typeof batchRows>();
  for (const batch of batchRows) {
    const bucket = batchesByAgent.get(batch.agentId);
    if (bucket) bucket.push(batch);
    else batchesByAgent.set(batch.agentId, [batch]);
  }
  const claimedAgents = new Set(claimRows.map((row) => row.agentId));
  const listed = [];
  for (const agent of rows) {
    const name = agent.shopName || agent.name;
    if (query.search && !name.toLowerCase().includes(query.search.toLowerCase()) && !agent.name.includes(query.search)) {
      continue;
    }
    const view = partition(linesByAgent.get(agent.id) || []);
    const batches = batchesByAgent.get(agent.id) || [];
    const latest = batches[0];
    const activeClaims = claimedAgents.has(agent.id) ? [agent.id] : [];
    const open = view.openTotals.itemCount > 0;
    const pending = batches.some(
      (batch) => batch.status === "draft" || batch.status === "pending_payment" || batch.status === "correction_pending",
    );
    // A group is cleared only when every batch is terminal and no source remains
    // open, skipped, or actively claimed/locked by an unsettled batch.
    const cleared = !open && !view.lockedTotals.itemCount && !activeClaims.length && !view.skipped.length && !pending;
    const review = view.skipped.length > 0;
    if (query.status === "balance" && !open) continue;
    if (query.status === "pending_payment" && !pending) continue;
    if (query.status === "cleared" && !cleared) continue;
    if (query.status === "review" && !review) continue;
    if (!open && !pending && !review && !latest) continue;
    listed.push({
      agentId: agent.id,
      name,
      storeEarningCents: view.openTotals.storeEarningCents,
      adjustmentCents: view.openTotals.adjustmentCents,
      drawDebtCents: view.openTotals.drawDebtCents,
      netCents: view.openTotals.netCents,
      direction: view.openTotals.direction,
      itemCount: view.openTotals.itemCount,
      skippedCount: view.skipped.length,
      lockedNetCents: view.lockedTotals.netCents,
      latestBatch: latest
        ? {
            id: latest.id,
            batchNo: latest.batchNo,
            status: latest.status,
            netCents: latest.netCents,
            storeEarningCents: latest.storeEarningCents,
            adjustmentCents: latest.adjustmentCents,
            drawDebtCents: latest.drawDebtCents,
            storeCount: latest.storeCount,
            adjustmentCount: latest.adjustmentCount,
            drawCount: latest.drawCount,
            version: latest.version,
            snapshotHash: latest.snapshotHash,
          }
        : null,
      updatedAt: view.open[0]?.occurredAt || latest?.createdAt || "",
    });
  }
  listed.sort((a, b) => {
    if (query.sort === "name") return a.name.localeCompare(b.name, "zh");
    if (query.sort === "updated") return b.updatedAt.localeCompare(a.updatedAt);
    return Math.abs(b.netCents) - Math.abs(a.netCents);
  });
  const offset = query.cursor ? Number(query.cursor) || 0 : 0;
  const page = listed.slice(offset, offset + query.limit);
  const payable = listed
    .filter((row) => row.netCents > 0)
    .reduce((sum, row) => sum + row.netCents, 0);
  const receivable = listed
    .filter((row) => row.netCents < 0)
    .reduce((sum, row) => sum + row.netCents, 0);
  return {
    cutoffAt: query.cutoffAt,
    currency: "CNY" as const,
    summary: {
      openAgents: listed.filter((row) => row.itemCount > 0).length,
      platformPaysCents: payable,
      agentPaysCents: receivable,
      reviewOrders: listed.reduce((sum, row) => sum + row.skippedCount, 0),
    },
    list: page,
    nextCursor: offset + query.limit < listed.length ? String(offset + query.limit) : null,
  };
}

export async function getReconciliation(id: number, agentId?: number) {
  const batch = await db.query.agentReconciliationBatches.findFirst({
    where: eq(agentReconciliationBatches.id, id),
  });
  if (!batch || (agentId && batch.agentId !== agentId)) return null;
  const audits = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.targetType, "agent_reconciliation_batch"), eq(auditLogs.targetId, String(id))))
    .orderBy(desc(auditLogs.id));
  return { batch, audits };
}

export async function listReconciliationItems(id: number, agentId: number | undefined, cursor: number, limit: number, type: string) {
  const batch = await db.query.agentReconciliationBatches.findFirst({
    where: eq(agentReconciliationBatches.id, id),
  });
  if (!batch || (agentId && batch.agentId !== agentId)) return null;
  const conditions = [eq(agentReconciliationItems.batchId, id)];
  if (type) conditions.push(eq(agentReconciliationItems.sourceType, type));
  const rows = await db
    .select()
    .from(agentReconciliationItems)
    .where(and(...conditions))
    .orderBy(agentReconciliationItems.id)
    .offset(cursor)
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    batchNo: batch.batchNo,
    snapshotHash: batch.snapshotHash,
    items: page.map((row) => ({
      ...row,
      snapshot: JSON.parse(row.snapshotJson) as Record<string, unknown>,
    })),
    nextCursor: rows.length > limit ? cursor + limit : null,
  };
}

export function itemsCsv(batchNo: string, hash: string, items: Array<{ sourceOrderNo: string; sourceType: string; amountCents: number; snapshotJson: string }>) {
  const header = ["batchNo", "snapshotHash", "orderNo", "type", "amountCents", "snapshot"].join(",");
  const lines = items.map((item) =>
    [batchNo, hash, item.sourceOrderNo, item.sourceType, item.amountCents, item.snapshotJson]
      .map((value) => {
        const text = String(value);
        const guarded = /^[=+\-@]/.test(text) ? `'${text}` : text;
        return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
      })
      .join(","),
  );
  return `\uFEFF${header}\n${lines.join("\n")}\n`;
}

/**
 * 代理端批次视图：只给前端要展示的字段。
 * 不含 agentId、periodLabel、snapshotHash、createdBy、paymentNote 这些内部字段。
 */
export function agentBatchView(batch: typeof agentReconciliationBatches.$inferSelect) {
  return {
    id: batch.id,
    batchNo: batch.batchNo,
    status: batch.status,
    cutoffAt: batch.cutoffAt,
    currency: batch.currency,
    direction: batch.direction,
    netCents: batch.netCents,
    storeEarningCents: batch.storeEarningCents,
    adjustmentCents: batch.adjustmentCents,
    drawDebtCents: batch.drawDebtCents,
    storeCount: batch.storeCount,
    adjustmentCount: batch.adjustmentCount,
    drawCount: batch.drawCount,
    version: batch.version,
    createdAt: batch.createdAt,
    paidAt: batch.paidAt,
    cancelledAt: batch.cancelledAt,
    paymentMethod: batch.paymentMethod,
    paymentReference: batch.paymentReference,
    actualPaymentAt: batch.actualPaymentAt,
  };
}

export async function listAgentBatches(agentId: number, cursor: number, limit: number) {
  const rows = await db
    .select()
    .from(agentReconciliationBatches)
    .where(eq(agentReconciliationBatches.agentId, agentId))
    .orderBy(desc(agentReconciliationBatches.id))
    .offset(cursor)
    .limit(limit + 1);
  return {
    list: rows.slice(0, limit),
    nextCursor: rows.length > limit ? cursor + limit : null,
  };
}
