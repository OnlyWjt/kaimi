import { and, asc, eq, sql } from "drizzle-orm";
import { db, client } from "@/db";
import { cdkPool, plansCache, products } from "@/db/schema";
import { bootDb } from "@/lib/config";
import { maskCode } from "@/lib/crypto";
import { getUpstreamClient } from "@/lib/upstream";

/** 与主站 normalizeCDKCode 对齐：trim + 大写，避免对账误伤 */
export function normalizeCdkCode(code: string) {
  return code.trim().toUpperCase();
}

export async function findCdkByCode(code: string) {
  const normalized = normalizeCdkCode(code);
  if (!normalized) return undefined;
  const exact = await db.query.cdkPool.findFirst({ where: eq(cdkPool.code, normalized) });
  if (exact) return exact;
  const rows = await db
    .select()
    .from(cdkPool)
    .where(sql`upper(trim(${cdkPool.code})) = ${normalized}`)
    .limit(1);
  return rows[0];
}

export async function syncCdksFromUpstream() {
  await bootDb();
  const upstream = await getUpstreamClient();
  let page = 1;
  let imported = 0;
  let restored = 0;
  let incomplete = false;
  const upstreamUnused = new Set<string>();

  for (;;) {
    const res = await upstream.listCdks({ page, page_size: 100, status: "unused" });
    const list = res.list ?? [];
    if (list.length === 0) break;

    for (const item of list) {
      if (!item.code) continue;
      const code = normalizeCdkCode(item.code);
      upstreamUnused.add(code);
      const existing = await findCdkByCode(code);
      if (existing) {
        // 主站重新分配回来 / 误禁用恢复
        if (existing.status === "disabled") {
          await db
            .update(cdkPool)
            .set({
              code,
              status: "unused",
              planKey: String(item.plan || existing.planKey),
              orderId: null,
              lockedAt: null,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(cdkPool.id, existing.id));
          restored += 1;
          continue;
        }
        const patch: { code?: string; planKey?: string; updatedAt: string } = {
          updatedAt: new Date().toISOString(),
        };
        if (existing.code !== code) patch.code = code;
        if (item.plan && existing.planKey !== item.plan) patch.planKey = item.plan;
        if (patch.code || patch.planKey) {
          await db.update(cdkPool).set(patch).where(eq(cdkPool.id, existing.id));
        }
        continue;
      }
      await db.insert(cdkPool).values({
        code,
        planKey: String(item.plan || "unknown"),
        status: "unused",
        source: "sync",
      });
      imported += 1;
    }

    if (list.length < 100) break;
    page += 1;
    if (page > 50) {
      incomplete = true;
      break;
    }
  }

  // 对账：上游 unused 列表里没有的本地可用码 → 禁用（大小写归一后比较）
  // 仅在完整拉完列表后执行；空列表且本地有库存时仍对账（可能是全部收回）。
  let disabled = 0;
  if (!incomplete) {
    // 只对账 unused：sold 是客户已购码，上游 unused 列表本来就不会再出现
    const localUnused = await db
      .select({ id: cdkPool.id, code: cdkPool.code })
      .from(cdkPool)
      .where(eq(cdkPool.status, "unused"));
    const now = new Date().toISOString();
    for (const row of localUnused) {
      if (upstreamUnused.has(normalizeCdkCode(row.code))) continue;
      await db
        .update(cdkPool)
        .set({ status: "disabled", updatedAt: now })
        .where(and(eq(cdkPool.id, row.id), eq(cdkPool.status, "unused")));
      disabled += 1;
    }
  }

  return { imported, restored, disabled, incomplete };
}

/** 主站已收回时，把本地可兑码标为禁用 */
export async function markCodeDisabledByCode(code: string) {
  await bootDb();
  const normalized = normalizeCdkCode(code);
  const now = new Date().toISOString();
  await db
    .update(cdkPool)
    .set({ status: "disabled", updatedAt: now })
    .where(
      and(
        sql`upper(trim(${cdkPool.code})) = ${normalized}`,
        eq(cdkPool.status, "unused"),
      ),
    );
}

const RECLAIM_ERROR_CODES = new Set([
  "CDK_NOT_ASSIGNED",
  "CDK_WRONG_AGENT",
  "CDK_NOT_FOUND",
]);

async function restoreCdkIfDisabled(normalized: string, planKey?: string) {
  const row = await findCdkByCode(normalized);
  if (!row) return;
  const needsCode = row.code !== normalized;
  const needsPlan = Boolean(planKey && planKey !== row.planKey);
  const needsRestore = row.status === "disabled";
  if (!needsCode && !needsPlan && !needsRestore) return;

  await db
    .update(cdkPool)
    .set({
      ...(needsCode ? { code: normalized } : {}),
      ...(needsPlan ? { planKey: planKey! } : {}),
      ...(needsRestore ? { status: "unused" as const, orderId: null, lockedAt: null } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(cdkPool.id, row.id));
}

/**
 * 问主站卡密是否仍归属本代理且可用。
 * 仅在明确「未分配/错代理/不存在」时本地禁用；套餐不一致会尝试纠正 planKey。
 * 上游网络失败返回 skipped。
 */
export async function ensureUpstreamCdkUsable(planKey: string, code: string): Promise<"ok" | "skipped"> {
  const normalized = normalizeCdkCode(code);
  let effectivePlan = planKey;

  try {
    const upstream = await getUpstreamClient();

    // 套餐可能本地写错：先按码查上游真实 plan
    try {
      const listed = await upstream.listCdks({ code: normalized, page_size: 20 });
      const hit = (listed.list ?? []).find((c) => normalizeCdkCode(String(c.code || "")) === normalized);
      if (hit?.plan && hit.plan !== effectivePlan) {
        effectivePlan = String(hit.plan);
        const row = await findCdkByCode(normalized);
        if (row) {
          await db
            .update(cdkPool)
            .set({ planKey: effectivePlan, code: normalized, updatedAt: new Date().toISOString() })
            .where(eq(cdkPool.id, row.id));
        }
      }
      // 上游库存里能查到且为 unused → 本地曾误禁用则恢复
      if (hit && (!hit.status || hit.status === "unused")) {
        await restoreCdkIfDisabled(normalized, effectivePlan);
      }
    } catch (listErr) {
      console.warn("[kaimi] listCdks by code skipped:", listErr);
    }

    const res = await upstream.validateCdks({ plan: effectivePlan, codes: [normalized] });
    const summary = res.summary as {
      valid_count?: number;
      validCount?: number;
      invalid?: Array<{ error_code?: string; errorCode?: string; message?: string }>;
    };
    const validCount = Number(summary?.valid_count ?? summary?.validCount ?? 0);
    if (validCount > 0) {
      await restoreCdkIfDisabled(normalized, effectivePlan);
      return "ok";
    }

    const issue = summary?.invalid?.[0];
    const errCode = String(issue?.error_code || issue?.errorCode || "");

    // 套餐不一致：再拉一次真实 plan 重试，仍失败则提示同步，不禁用
    if (errCode === "CDK_PLAN_MISMATCH") {
      throw new Error("卡密套餐信息不一致，请稍后再试");
    }

    const msg =
      issue?.message ||
      (errCode === "CDK_NOT_ASSIGNED" || errCode === "CDK_WRONG_AGENT"
        ? "该卡密已不可用"
        : errCode
          ? "上游卡密不可用"
          : "暂时无法确认该卡密，请稍后再试");

    // 只有明确收回类错误才本地禁用；空 error_code 不禁用
    if (RECLAIM_ERROR_CODES.has(errCode)) {
      await markCodeDisabledByCode(normalized);
    }

    throw new Error(msg);
  } catch (err) {
    if (
      err instanceof Error &&
      /收回|不可用|不存在|禁用|分配|套餐|未确认|同步/.test(err.message)
    ) {
      throw err;
    }
    console.warn("[kaimi] upstream cdk ensure skipped:", err);
    return "skipped";
  }
}

export async function syncPlansFromUpstream() {
  await bootDb();
  const upstream = await getUpstreamClient();
  const list = await upstream.fetchPlans();
  let upserted = 0;
  let productsUpserted = 0;
  let sortOrder = 0;

  for (const plan of list) {
    const key = String(plan.key || "");
    if (!key) continue;
    const name = String(plan.label || plan.name || key);
    let priceCents = 0;
    if (typeof plan.price_cny_cents === "number") {
      priceCents = Math.round(plan.price_cny_cents);
    } else if (typeof plan.price === "number") {
      priceCents = Math.round(plan.price < 1000 ? plan.price * 100 : plan.price);
    } else if (typeof plan.price_yuan === "string" && plan.price_yuan) {
      priceCents = Math.round(Number(plan.price_yuan) * 100) || 0;
    }

    const existing = await db.query.plansCache.findFirst({
      where: eq(plansCache.planKey, key),
    });
    if (existing) {
      await db
        .update(plansCache)
        .set({
          name,
          upstreamPriceCents: priceCents,
          rawJson: JSON.stringify(plan),
          syncedAt: new Date().toISOString(),
        })
        .where(eq(plansCache.id, existing.id));
    } else {
      await db.insert(plansCache).values({
        planKey: key,
        name,
        upstreamPriceCents: priceCents,
        rawJson: JSON.stringify(plan),
      });
    }
    upserted += 1;

    // Also upsert shop products so /recharge can list them (kind=recharge).
    const product = await db.query.products.findFirst({
      where: and(eq(products.kind, "recharge"), eq(products.upstreamPlan, key)),
    });
    const now = new Date().toISOString();
    if (product) {
      await db
        .update(products)
        .set({
          title: name,
          priceCents,
          enabled: true,
          sortOrder,
          updatedAt: now,
        })
        .where(eq(products.id, product.id));
    } else {
      await db.insert(products).values({
        kind: "recharge",
        title: name,
        priceCents,
        upstreamPlan: key,
        stockVisible: true,
        enabled: true,
        sortOrder,
      });
    }
    productsUpserted += 1;
    sortOrder += 1;
  }

  return { upserted, productsUpserted, total: list.length };
}

/** Atomically reserve N unused codes for a plan. */
export async function reserveCodes(planKey: string, quantity: number, orderId: number) {
  if (quantity < 1) throw new Error("quantity must be >= 1");

  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(cdkPool)
      .where(and(eq(cdkPool.status, "unused"), eq(cdkPool.planKey, planKey)))
      .orderBy(asc(cdkPool.id))
      .limit(quantity);

    if (rows.length < quantity) {
      throw new Error(`库存不足：需要 ${quantity}，可用 ${rows.length}`);
    }

    const now = new Date().toISOString();
    for (const row of rows) {
      const updated = await tx
        .update(cdkPool)
        .set({
          status: "locked",
          orderId,
          lockedAt: now,
          updatedAt: now,
        })
        .where(and(eq(cdkPool.id, row.id), eq(cdkPool.status, "unused")))
        .returning({ id: cdkPool.id });

      if (!updated.length) {
        throw new Error("库存抢占失败，请重试");
      }
    }

    return rows.map((r) => ({ id: r.id, code: r.code, planKey: r.planKey }));
  });
}

export async function markCodesSold(codeIds: number[]) {
  const now = new Date().toISOString();
  for (const id of codeIds) {
    await db
      .update(cdkPool)
      .set({ status: "sold", soldAt: now, updatedAt: now })
      .where(and(eq(cdkPool.id, id), eq(cdkPool.status, "locked")));
  }
}

export async function markCodeUsed(code: string) {
  const now = new Date().toISOString();
  const normalized = normalizeCdkCode(code);
  await client.execute({
    sql: `UPDATE cdk_pool SET status = 'used', used_at = ?, updated_at = ?
           WHERE upper(trim(code)) = ? AND status IN ('locked', 'unused', 'sold')`,
    args: [now, now, normalized],
  });
}

export async function releaseLockedCode(code: string) {
  const now = new Date().toISOString();
  const row = await findCdkByCode(code);
  // 售出后兑换失败：回到 sold；代理库存锁失败：回到 unused
  const restore = row?.soldAt ? "sold" : "unused";
  if (!row) return;
  await db
    .update(cdkPool)
    .set({
      status: restore,
      orderId: null,
      lockedAt: null,
      updatedAt: now,
    })
    .where(and(eq(cdkPool.id, row.id), eq(cdkPool.status, "locked")));
}

/** 客户持码兑换：锁定指定卡密（unused / sold 可兑） */
export async function lockCodeForRedeem(code: string, orderId: number) {
  await bootDb();
  const row = await findCdkByCode(code);
  if (!row) throw new Error("卡密不存在");
  if (row.status === "used") throw new Error("该卡密已使用");
  if (row.status === "locked") throw new Error("该卡密占用中，请稍后再试或查询订单进度");
  if (row.status === "disabled") throw new Error("该卡密已禁用");
  if (row.status !== "unused" && row.status !== "sold") {
    throw new Error(`卡密状态不可兑换：${row.status}`);
  }

  const now = new Date().toISOString();
  const updated = await db
    .update(cdkPool)
    .set({
      status: "locked",
      orderId,
      lockedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(cdkPool.id, row.id),
        // re-check status atomically
        eq(cdkPool.status, row.status),
      ),
    )
    .returning();

  if (!updated.length) throw new Error("卡密抢占失败，请重试");
  return { id: row.id, code: row.code, planKey: row.planKey };
}

/** 兑换前校验：本地 + 上游实时预检（误禁用可被上游确认后恢复） */
export async function validateCodeForRedeem(code: string) {
  await bootDb();
  const trimmed = code.trim();
  if (!trimmed || trimmed.length < 6) {
    throw new Error("请输入完整卡密");
  }

  let row = await findCdkByCode(trimmed);
  if (!row) {
    return { ok: false as const, error: "未找到该卡密" };
  }

  const statusLabel: Record<string, string> = {
    unused: "未使用",
    locked: "占用中",
    sold: "已售出",
    used: "已核销/已使用",
    disabled: "已禁用",
  };

  if (row.status === "used") {
    return { ok: false as const, error: "该卡密已使用", status: statusLabel.used, planKey: row.planKey };
  }
  if (row.status === "locked") {
    return {
      ok: false as const,
      error: "该卡密占用中，请查询订单进度",
      status: statusLabel.locked,
      planKey: row.planKey,
    };
  }

  // unused / sold / disabled 都问上游：可恢复误禁用，或确认真正收回
  try {
    await ensureUpstreamCdkUsable(row.planKey, row.code);
    row = (await findCdkByCode(trimmed)) ?? row;
  } catch (err) {
    if (err instanceof Error && /收回|不可用|不存在|禁用|分配|套餐|未确认|同步/.test(err.message)) {
      const fresh = await findCdkByCode(trimmed);
      return {
        ok: false as const,
        error: err.message,
        status: statusLabel[fresh?.status || "disabled"] || "已禁用",
        planKey: row.planKey,
      };
    }
    console.warn("[kaimi] upstream cdk validate skipped:", err);
  }

  if (row.status === "disabled") {
    return {
      ok: false as const,
      error: "该卡密已不可用",
      status: statusLabel.disabled,
      planKey: row.planKey,
    };
  }
  if (row.status !== "unused" && row.status !== "sold") {
    return { ok: false as const, error: `卡密状态不可兑换：${row.status}`, planKey: row.planKey };
  }

  const plan = await db.query.plansCache.findFirst({ where: eq(plansCache.planKey, row.planKey) });
  const product = await db.query.products.findFirst({
    where: and(eq(products.upstreamPlan, row.planKey), eq(products.kind, "recharge"), eq(products.enabled, true)),
  });

  return {
    ok: true as const,
    codeMasked: maskCode(row.code),
    status: statusLabel[row.status] || row.status,
    planKey: row.planKey,
    planName: product?.title || plan?.name || row.planKey,
    productId: product?.id ?? null,
    price: product ? (product.priceCents / 100).toFixed(2) : undefined,
  };
}

export async function countUnused(planKey?: string) {
  await bootDb();
  if (planKey) {
    const rows = await db
      .select({ c: sql<number>`count(*)` })
      .from(cdkPool)
      .where(and(eq(cdkPool.status, "unused"), eq(cdkPool.planKey, planKey)));
    return Number(rows[0]?.c ?? 0);
  }
  const rows = await db
    .select({ c: sql<number>`count(*)` })
    .from(cdkPool)
    .where(eq(cdkPool.status, "unused"));
  return Number(rows[0]?.c ?? 0);
}

export async function countByStatus() {
  await bootDb();
  const rows = await db
    .select({
      status: cdkPool.status,
      c: sql<number>`count(*)`,
    })
    .from(cdkPool)
    .groupBy(cdkPool.status);
  const map: Record<string, number> = {
    unused: 0,
    locked: 0,
    sold: 0,
    used: 0,
    disabled: 0,
  };
  for (const r of rows) {
    map[r.status] = Number(r.c ?? 0);
  }
  return map;
}

/** 核销：标记为已使用（不可再卖/再兑） */
export async function voidCode(id: number) {
  const row = await db.query.cdkPool.findFirst({ where: eq(cdkPool.id, id) });
  if (!row) throw new Error("卡密不存在");
  if (row.status === "used") return row;
  if (row.status === "disabled") throw new Error("已禁用的卡密请先启用再核销，或保持禁用");
  const now = new Date().toISOString();
  const [updated] = await db
    .update(cdkPool)
    .set({ status: "used", usedAt: now, updatedAt: now })
    .where(eq(cdkPool.id, id))
    .returning();
  return updated;
}

/** 禁用：不可售、不可兑 */
export async function disableCode(id: number) {
  const row = await db.query.cdkPool.findFirst({ where: eq(cdkPool.id, id) });
  if (!row) throw new Error("卡密不存在");
  if (row.status === "used") throw new Error("已核销卡密不能禁用");
  if (row.status === "locked") throw new Error("占用中的卡密不能禁用，请等待开通结束");
  const now = new Date().toISOString();
  const [updated] = await db
    .update(cdkPool)
    .set({ status: "disabled", updatedAt: now })
    .where(eq(cdkPool.id, id))
    .returning();
  return updated;
}

/** 启用：disabled → unused */
export async function enableCode(id: number) {
  const row = await db.query.cdkPool.findFirst({ where: eq(cdkPool.id, id) });
  if (!row) throw new Error("卡密不存在");
  if (row.status !== "disabled") throw new Error("仅已禁用卡密可启用");
  const now = new Date().toISOString();
  const [updated] = await db
    .update(cdkPool)
    .set({
      status: "unused",
      orderId: null,
      lockedAt: null,
      updatedAt: now,
    })
    .where(eq(cdkPool.id, id))
    .returning();
  return updated;
}
