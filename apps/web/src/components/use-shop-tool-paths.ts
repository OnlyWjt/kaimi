"use client";

import { usePathname } from "next/navigation";
import {
  shopCdkPath,
  shopLookupPath,
  shopRedeemPath,
  shopSlugFromPathname,
} from "@/lib/agent-redeem-core";

/** 兑换/查卡/查单表单共用：在店铺子页里跳本店，平台页仍走裸路径。 */
export function useShopToolPaths() {
  const slug = shopSlugFromPathname(usePathname() || "");
  return {
    slug,
    recharge: shopRedeemPath(slug),
    cdk: shopCdkPath(slug),
    lookup: shopLookupPath(slug),
    lookupOrder: (orderNo: string) => shopLookupPath(slug, orderNo),
  };
}
