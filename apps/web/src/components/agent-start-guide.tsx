"use client";

import { useEffect, useState } from "react";
import { toast } from "@/components/toast";
import { copyText } from "@/lib/copy-text";

export function AgentStartGuide() {
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const loginUrl = origin ? `${origin}/login` : "/login";

  return (
    <div className="space-y-4">
      <section className="km-panel space-y-3">
        <h2 className="text-lg font-semibold">三步开店</h2>
        <ol className="km-guide-steps">
          <li>
            打开{" "}
            <a className="underline" href="/login">
              {loginUrl}
            </a>
            ，用平台给你的账号登录。进去先点「修改密码」。
          </li>
          <li>
            进「店铺」选主题、改一个好记的店名，保存。再进「售价与优惠」把每个套餐的零售价填进「可填区间」（不能低于成本，也不能超过上限）。
          </li>
          <li>把店铺链接发给客户。收款和出卡密都是自动的，不用你手动发货。</li>
        </ol>
      </section>

      <section className="km-panel space-y-3">
        <h2 className="text-lg font-semibold">客户怎么买</h2>
        <ul className="list-disc space-y-2 pl-5 text-sm text-[var(--km-fg-muted)]">
          <li>打开你的店铺链接，选套餐，可一次买多张，填自己的邮箱后付款。</li>
          <li>付完款页面会出卡密。买多张时可能先出一部分，其余会继续出现在同一页，让客户别重复付款。</li>
          <li>点「去兑换」，填自己的账号信息提交即可。提交后马上有订单号，开通在后台继续跑，不用盯着转圈。</li>
          <li>
            卡密丢了：回店铺页查单。只填邮箱只能看到卡密后几位；要完整卡密必须用订单号。你也能在后台「已售卡密」里帮他看。
          </li>
        </ul>
      </section>

      <section className="km-panel space-y-3">
        <h2 className="text-lg font-semibold">别踩这几条</h2>
        <ul className="list-disc space-y-2 pl-5 text-sm text-[var(--km-fg-muted)]">
          <li>「已售卡密」是已经卖给客户的，不要自己拿去兑换，兑掉等于把客户的货用了。</li>
          <li>「批量兑换」只用来帮卡住的客户走完流程，或兑你自己手里的码，不会读取已售列表。</li>
          <li>开通显示「核对中 / 结果待确认」时不要再点一次提交，可能已经扣过费了。把订单号发给平台。</li>
          <li>套餐显示「平台暂时缺货」或零售价没落在区间里，客户店铺里看不到这个套餐。</li>
        </ul>
      </section>

      <div className="flex flex-wrap gap-2">
        <a className="km-btn" href="/login">
          去登录
        </a>
        <button
          type="button"
          className="km-btn km-btn-ghost"
          onClick={() =>
            void copyText(loginUrl)
              .then(() => toast("登录地址已复制"))
              .catch((error) =>
                toast(error instanceof Error ? error.message : "复制失败", "err"),
              )
          }
        >
          复制登录地址
        </button>
      </div>
    </div>
  );
}
