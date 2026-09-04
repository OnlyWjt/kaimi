import { getSetting } from "@/lib/config";
import { normalizeMaxOrderQuantity } from "@/lib/store-quantity-core";

export {
  DEFAULT_MAX_ORDER_QUANTITY,
  HARD_MAX_ORDER_QUANTITY,
  normalizeMaxOrderQuantity,
  resolveOrderQuantity,
} from "@/lib/store-quantity-core";

export const MAX_ORDER_QUANTITY_SETTING = "store_max_order_quantity";

export async function getMaxOrderQuantity() {
  return normalizeMaxOrderQuantity(
    await getSetting(MAX_ORDER_QUANTITY_SETTING, ""),
  );
}
