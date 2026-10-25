import type { AskOptions } from "@/components/ask-dialog";
import { toast } from "@/components/toast";
import { readApiJson } from "@/lib/http-error";
import { yuanTextFromCents } from "@/lib/money";

/**
 * 代理自己作废一张提的卡：先问原因，再调接口。自助提卡和卡密查询共用。
 * 作废成功返回 true，调用方刷新列表。
 */
export async function voidDrawItemWithReason(
  ask: (options: AskOptions) => Promise<Record<string, string> | null>,
  item: { id: number; codeMasked: string; amountCents?: number },
  quota?: { used: number; limit: number } | null,
) {
  const left = quota ? Math.max(0, quota.limit - quota.used) : null;
  const answer = await ask({
    title: `作废卡密 ${item.codeMasked}？`,
    message: [
      "作废后卡密立即失效，不能恢复",
      item.amountCents ? `，这张卡的 ¥${yuanTextFromCents(item.amountCents)} 不再计入你的提卡费用` : "，这张卡不再计入你的提卡费用",
      "。",
      left != null ? `今天还能自助作废 ${left} 张。` : "",
    ].join(""),
    fields: [{ name: "reason", label: "作废原因", placeholder: "例如：买家退款、卡发重了", required: true }],
    confirmLabel: "作废",
    danger: true,
  });
  if (!answer) return false;
  try {
    const data = await readApiJson<{ amountCents?: number }>(
      await fetch(`/api/agent/draw/items/${item.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "void", reason: answer.reason || "" }),
      }),
    );
    toast(
      data.amountCents ? `已作废，¥${yuanTextFromCents(data.amountCents)} 不再计费` : "已作废",
    );
    return true;
  } catch (error) {
    toast(error instanceof Error ? error.message : "作废失败，请稍后再试或联系平台", "err");
    return false;
  }
}
