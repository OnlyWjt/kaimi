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
    <div className="mx-auto w-full space-y-4">
      <div className="km-tabs">
        <button
          type="button"
          className={`km-tab ${mode === "single" ? "km-tab-active" : ""}`}
          onClick={() => setMode("single")}
        >
          单张兑换
        </button>
        <button
          type="button"
          className={`km-tab ${mode === "batch" ? "km-tab-active" : ""}`}
          onClick={() => setMode("batch")}
        >
          批量兑换
        </button>
      </div>
      {mode === "single" ? (
        <RechargeForm initialCode={initialCode} />
      ) : (
        <BatchRedeemForm limit={batchLimit} orderRef={orderRef} />
      )}
    </div>
  );
}
