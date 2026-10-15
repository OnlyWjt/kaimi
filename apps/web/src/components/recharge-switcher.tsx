"use client";

import { useState } from "react";
import { BatchRedeemForm } from "@/components/batch-redeem-form";
import { RechargeForm } from "@/components/recharge-form";

export function RechargeSwitcher({
  initialCode = "",
  batchLimit,
  orderRef,
}: {
  initialCode?: string;
  batchLimit: number;
  orderRef?: { orderNo: string; queryToken: string };
}) {
  // 从多张卡的订单跳进来的人要的就是批量，别让他先点一下标签。
  const [mode, setMode] = useState<"single" | "batch">(orderRef ? "batch" : "single");

  return (
    <div className="km-rx-switch">
      <div className="km-rx-seg" role="tablist" aria-label="兑换方式">
        {(
          [
            ["single", "单张兑换"],
            ["batch", "批量兑换"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            className={`km-rx-seg-item${mode === value ? " km-rx-seg-item-active" : ""}`}
            onClick={() => setMode(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === "single" ? (
        <RechargeForm initialCode={initialCode} />
      ) : (
        <BatchRedeemForm limit={batchLimit} orderRef={orderRef} />
      )}
    </div>
  );
}
