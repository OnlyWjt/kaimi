import { BatchRedeemForm } from "@/components/batch-redeem-form";
import { getBatchRedeemLimit } from "@/lib/batch-redeem-limit";

export default async function AgentBatchRedeemPage() {
  const batchLimit = await getBatchRedeemLimit();
  return (
    <>
      <header className="km-acp-head">
        <div>
          <h1>批量兑换</h1>
          <p>把要兑换的卡密粘进来，填一次账号就能一起开通。一次最多 {batchLimit} 张。</p>
        </div>
      </header>
      <div className="km-panel space-y-2">
        <p className="text-sm font-medium">这个工具只兑换你手动粘进来的卡密</p>
        <p className="text-sm leading-relaxed text-[var(--km-fg-muted)]">
          用来帮卡在兑换页的客户走完流程，或者兑换你自己买的卡。
          「已售卡密」列表里的卡已经卖给客户了，兑换掉就等于把客户付过钱的东西用了，
          所以那边不提供批量兑换，这里也不读那个列表。
        </p>
      </div>
      <BatchRedeemForm limit={batchLimit} />
    </>
  );
}
