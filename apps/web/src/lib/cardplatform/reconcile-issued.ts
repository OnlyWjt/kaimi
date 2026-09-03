import { eq } from "drizzle-orm";
import { db } from "@/db";
import { cardplatformAccounts } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/config";
import { getCardplatformClientById } from "./config";
import { applyIssuedCdkStatus } from "./issued-status";

const PAGE_SIZE = 100;
/** 每轮最多 5 个请求/账户；卡台限流是每密钥 300 次/分钟。 */
const MAX_PAGES = 5;
/** 水位线回退一分钟，避免同一秒的多条记录被跳过。 */
const OVERLAP_SECONDS = 60;
const FIRST_RUN_LOOKBACK_HOURS = 24;

export type ReconcileIssuedResult = {
  accountId: number;
  checked: number;
  updated: number;
  error?: string;
};

function cursorKey(accountId: number) {
  return `cdk_order_cursor_${accountId}`;
}

async function reconcileAccount(accountId: number): Promise<ReconcileIssuedResult> {
  const stored = (await getSetting(cursorKey(accountId), "")).trim();
  const since =
    stored ||
    new Date(
      Date.now() - FIRST_RUN_LOOKBACK_HOURS * 60 * 60 * 1000,
    ).toISOString();
  const { client } = await getCardplatformClientById(accountId);

  let checked = 0;
  let updated = 0;
  let newestMs = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { list } = await client.listCdkOrders({
      page,
      pageSize: PAGE_SIZE,
      updatedAfter: since,
    });
    if (list.length === 0) break;
    for (const row of list) {
      checked += 1;
      const ms = Date.parse(row.updatedAt);
      if (Number.isFinite(ms) && ms > newestMs) newestMs = ms;
      const changed = await applyIssuedCdkStatus({
        cdkId: row.cdkId,
        accountId,
        status: row.cdkStatus,
      });
      if (changed) updated += 1;
    }
    if (list.length < PAGE_SIZE) break;
  }

  if (newestMs > 0) {
    const next = new Date(newestMs - OVERLAP_SECONDS * 1000).toISOString();
    if (Date.parse(next) > Date.parse(since)) {
      await setSetting(cursorKey(accountId), next);
    }
  }
  return { accountId, checked, updated };
}

/**
 * 卡台只能配一个通用回调地址，Kaimi 又还没有公网 HTTPS 域名，
 * 所以按 updated_after 低频轮询 /gpt-direct/cdk-orders 兜住已发卡密的状态。
 * 回调接上以后这个任务可以降频，两条路径回写逻辑一致，重复不会改坏数据。
 */
export async function reconcileIssuedCdkStatuses() {
  const accounts = await db.query.cardplatformAccounts.findMany({
    where: eq(cardplatformAccounts.enabled, true),
  });
  const results: ReconcileIssuedResult[] = [];
  for (const account of accounts) {
    try {
      results.push(await reconcileAccount(account.id));
    } catch (error) {
      results.push({
        accountId: account.id,
        checked: 0,
        updated: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
