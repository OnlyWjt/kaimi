"use client";

import { useEffect, useState } from "react";
import { toast } from "@/components/toast";
import { copyText } from "@/lib/copy-text";

const FEATURES = [
  {
    group: "日常",
    items: [
      ["概览", "查看近 7 天成交、待结算金额和未兑换数量。"],
      ["公告", "查看平台发给全部代理的通知。"],
      ["通知", "绑定 Telegram 等渠道，接收付款和收益提醒。"],
    ],
  },
  {
    group: "销售",
    items: [
      ["店铺", "选择主题、修改店名。保存后复制店铺链接发给客户。"],
      ["售价与优惠", "在成本和上限之间填写零售价，也可以制作优惠券。平台新开放的套餐默认不上架，打开「在店里卖」才会出现在店里。未上架、未填写、超出区间，或平台暂时缺货时，客户在店铺中看不到该套餐。"],
    ],
  },
  {
    group: "账务",
    items: [
      ["账本", "查看每笔收益、期间统计，以及当前未结净额。这里的未结金额与平台对账页一致。"],
      ["自助提卡", "平台开通后才会出现。按成本向平台取卡，金额记为你应付平台的欠款，与商店收益一起结算。"],
      ["已售卡密", "查询已经卖给客户的卡密和兑换状态。这些卡密属于客户，不要自行兑换。"],
      ["开放 API", "需要对接自己的系统时使用。"],
    ],
  },
  {
    group: "工具",
    items: [
      ["使用说明", "登录后的详细说明，包含收益计算和常见问题。"],
      ["兑换卡密", "协助客户开通单张卡密。提交后会立即返回订单号。"],
      ["批量兑换", "粘贴多张卡密，填写一次账号一起开通。只处理你粘贴的卡密，不会读取已售列表。"],
      ["修改密码", "首次登录后请立即修改。修改后，其他已登录设备会退出。"],
    ],
  },
] as const;

export function AgentStartGuide() {
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const loginUrl = origin ? `${origin}/login` : "";

  return (
    <div className="space-y-4">
      <section className="km-panel space-y-3">
        <h2 className="text-lg font-semibold">1. 登录</h2>
        <p className="text-sm leading-relaxed text-[var(--km-fg-muted)]">
          使用平台提供的账号登录。进入后台后，先在左下角点击「修改密码」。
        </p>
        <p className="break-all rounded-xl bg-[var(--km-bg-muted)] px-3 py-2 font-mono text-xs">
          {loginUrl || "正在获取登录地址…"}
        </p>
      </section>

      <section className="km-panel space-y-4">
        <div>
          <h2 className="text-lg font-semibold">2. 后台功能</h2>
          <p className="mt-1 text-sm text-[var(--km-fg-muted)]">登录后左侧菜单与下面一致。</p>
        </div>
        {FEATURES.map((group) => (
          <div key={group.group}>
            <p className="text-xs font-medium text-[var(--km-fg-muted)]">{group.group}</p>
            <div className="mt-2 grid gap-2">
              {group.items.map(([name, text]) => (
                <div key={name} className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm">
                  <p className="font-medium">{name}</p>
                  <p className="mt-1 leading-relaxed text-[var(--km-fg-muted)]">{text}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="km-panel space-y-3">
        <h2 className="text-lg font-semibold">3. 客户如何购买</h2>
        <ol className="km-guide-steps">
          <li>把「店铺」里的链接发给客户。客户选择套餐，可一次购买多张，填写邮箱后付款。</li>
          <li>付款成功后，页面自动显示卡密和兑换入口。购买多张时可能先显示一部分，其余会继续出现在同一页，请客户不要重复付款。</li>
          <li>客户自行兑换：校验卡密后填写账号信息并提交。提交后立即获得订单号，开通在后台继续处理。</li>
          <li>卡密遗失时，让客户回到店铺用订单号查询。只填写邮箱只能看到卡密后几位。你也可以在「已售卡密」中协助查询。</li>
        </ol>
      </section>

      <section className="km-panel space-y-3">
        <h2 className="text-lg font-semibold">4. 如何结算</h2>
        <p className="text-sm leading-relaxed text-[var(--km-fg-muted)]">
          客户支付的款项进入平台账户。卡密发放完成后，该笔代理收益立即计算，可以在「账本」中查看。
        </p>
        <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm leading-relaxed">
          <p className="font-medium">商店收益</p>
          <p className="mt-1 text-[var(--km-fg-muted)]">
            收益 = 券后商品额 − 代理成本 − 代理承担的支付手续费。客户开票产生的加价默认归平台；平台给你开通自定义税点后，超出 6% 的部分扣税后计入你的收益。
          </p>
        </div>
        <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm leading-relaxed">
          <p className="font-medium">自助提卡</p>
          <p className="mt-1 text-[var(--km-fg-muted)]">
            仅在平台为你开通后可用。提卡按成本记账，未结算部分是你应付给平台的金额。
          </p>
        </div>
        <div className="rounded-xl bg-[var(--km-bg-muted)] px-3 py-3 text-sm leading-relaxed">
          <p className="font-medium">未结净额</p>
          <p className="mt-1 text-[var(--km-fg-muted)]">
            净额 = 商店收益 + 调整 − 未结提卡。大于 0 时平台付给你；小于 0 时你付给平台；等于 0 时双方抵平，仍由平台登记结清。
          </p>
        </div>
        <ol className="km-guide-steps">
          <li>不按自然周自动打款。需要结算时，联系平台，并在「账本」核对当前未结净额。该金额与平台看到的一致。</li>
          <li>线下转账完成后，由平台在后台登记「已结算」。代理不能自行点击结算。</li>
          <li>登记之后，已纳入的商店收益和提卡结清，之后的新订单和新提卡重新累计。结算后发生的退款或手续费差额，记入下一次未结。</li>
        </ol>
      </section>

      <section className="km-panel space-y-3">
        <h2 className="text-lg font-semibold">5. 请注意</h2>
        <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-[var(--km-fg-muted)]">
          <li>「已售卡密」中的卡密已经卖给客户。自行兑换等于使用了客户的商品。</li>
          <li>开通页面显示「核对中」或「结果待确认」时，不要再次提交。请把订单号发给平台。</li>
          <li>零售价未填写、超出可填区间，或套餐显示「平台暂时缺货」时，客户店铺中不会展示该套餐。</li>
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
            void copyText(loginUrl || `${window.location.origin}/login`)
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
