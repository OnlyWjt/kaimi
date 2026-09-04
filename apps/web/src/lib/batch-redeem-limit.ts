import { getSetting } from "@/lib/config";
import { normalizeBatchRedeemLimit } from "@/lib/recharge-batch-core";

export {
  DEFAULT_BATCH_REDEEM_LIMIT,
  HARD_MAX_BATCH_REDEEM_LIMIT,
  normalizeBatchRedeemLimit,
} from "@/lib/recharge-batch-core";

export const BATCH_REDEEM_LIMIT_SETTING = "recharge_batch_max_codes";

export async function getBatchRedeemLimit() {
  return normalizeBatchRedeemLimit(
    await getSetting(BATCH_REDEEM_LIMIT_SETTING, ""),
  );
}
