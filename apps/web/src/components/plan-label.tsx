import { splitHalfPlanName } from "@/lib/cardplatform/product";

/** Grok 首月半价卡密的标签。 */
export function HalfPriceTag() {
  return (
    <span className="km-badge km-badge-promo" title="仅限有 Grok 首月优惠资格的账号兑换">
      首月半价
    </span>
  );
}

/**
 * 后台列表里的套餐名：半价档位名字后面的「（首月半价）」换成标签。
 * 名字太长时只截名字，标签始终露出来。
 */
export function PlanLabel({ name, planKey, className = "" }: { name: string; planKey?: string | null; className?: string }) {
  const split = splitHalfPlanName(name, planKey);
  if (!split.half) return <span className={className}>{name}</span>;
  return (
    <span className={`km-plan-label ${className}`} title={name}>
      <span className="km-plan-label-name">{split.name}</span>
      <HalfPriceTag />
    </span>
  );
}
