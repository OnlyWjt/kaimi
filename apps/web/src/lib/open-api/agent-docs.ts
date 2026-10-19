export type DocBlock =
  | { kind: "p"; text: string }
  | { kind: "code"; text: string }
  | { kind: "table"; headers: string[]; rows: string[][] };

export type DocSection = {
  id: string;
  title: string;
  blocks: DocBlock[];
};

export function agentApiDocs(origin: string, options?: { includeDraw?: boolean }): DocSection[] {
  const base = `${origin}/api/v1/open`;
  const sections: DocSection[] = [
    {
      id: "auth",
      title: "调用约定",
      blocks: [
        { kind: "p", text: `基础地址 ${base}。每个请求都要带请求头 Authorization: Bearer km_live_你的Key。Key 只在创建时显示一次，丢了只能吊销后重建。` },
        { kind: "p", text: "正式 Key 必须设置 IP 白名单：只有白名单里的服务器能用这把 Key。填你服务器的公网出口 IP，可以填多个，也可以填网段（IPv4 最宽 /24，IPv6 最宽 /64）。权限和白名单建好后都能在「开放 API」页修改，改完马上生效，不用换 Key。被白名单拦下时返回 IP_NOT_ALLOWED，message 里写着我们看到的来源 IP，照着填进白名单即可。测试 Key 的白名单选填。" },
        { kind: "p", text: "代理 Key 只能操作自己的店铺：查套餐和订单、代客下单、看卡密、兑换自己卖出的卡。已开通提卡的代理还能用提卡接口。金额单位是分，时间是 UTC。代客下单的价格是你自己设的零售价。" },
        { kind: "p", text: "成功时 HTTP 200，正文是 { \"data\": ..., \"request_id\": \"req_...\" }。失败时 HTTP 状态码对应错误，正文是 { \"error\": { \"code\", \"message\" }, \"request_id\" }。排错时把 request_id 留着。" },
        {
          kind: "table",
          headers: ["错误码", "HTTP", "含义"],
          rows: [
            ["UNAUTHORIZED", "401", "没带 Key、Key 已吊销，或代理已被停用"],
            ["FORBIDDEN_SCOPE", "403", "这把 Key 没有该权限，到「开放 API」页编辑 Key 勾上即可"],
            ["IP_NOT_ALLOWED", "403", "来源 IP 不在这把 Key 的白名单里，或正式 Key 还没设白名单"],
            ["VALIDATION_FAILED", "400", "参数缺失或格式不对"],
            ["CDK_INVALID", "400", "卡密无效、已使用，或不属于本店"],
            ["NOT_FOUND", "404", "订单、卡密或兑换单不存在，或不属于本店"],
            ["CONFLICT", "409", "同一个 Idempotency-Key 正在处理，或被用到了不同的请求上"],
            ["RATE_LIMITED", "429", "这把 Key 超过每分钟次数"],
            ["REDEEM_BLOCKED", "429", "这把 Key 兑换失败过多，暂时封禁。不影响店铺前台"],
            ["INTERNAL", "500", "服务端错误"],
          ],
        },
        { kind: "p", text: "限流按单把 Key、在当前这台服务器的进程里计数。多台服务器各自计数，不会加总。" },
      ],
    },
    {
      id: "test-mode",
      title: "测试模式",
      blocks: [
        { kind: "p", text: "对接自己的分销站时，先在「开放 API」页建一把测试 Key（km_test_ 开头）。测试 Key 只能调 GET /plans、POST /orders/quote、POST /orders、GET /orders、GET /orders/{orderNo}，其余接口返回 FORBIDDEN_SCOPE。勾了「看卡密明文」的测试 Key，用 GET /orders/{orderNo}?reveal=1 看沙箱订单的假卡。" },
        { kind: "p", text: "套餐、价格、优惠券、地区确认都按正式规则校验，测试通过的参数在正式环境同样能下单。但订单只进沙箱：订单号 KT 开头，返回的 pay_url 是模拟付款链接，打开就算付款成功并发出 TEST- 开头的假卡，有 return_url 就跳回去，同时推 order.paid 和 order.delivered 回调。沙箱订单的返回和回调里都有 livemode: false，不扣钱、不进账本、不占库存，30 天后自动清理。" },
        { kind: "p", text: "跑通后把 Key 换成正式的 km_live_ 即可，代码不用改。建议你的接收端看到 livemode 为 false 时不要真的给买家发货。" },
      ],
    },
    {
      id: "plans",
      title: "GET /plans  查套餐",
      blocks: [
        { kind: "p", text: "权限 plans:read。返回本店现在能下单的套餐，和本站店铺页展示的一致。cost_cents 是你的成本，retail_price_cents 是你设的零售价。name、name_en、cover_url 是你在店铺装修里改过的名字和封面。" },
        { kind: "p", text: "同一套餐的不同地区是不同的 plan_key，base_plan_key 相同，可以按它归成一个商品、把地区做成规格。region 是付款地区（code 短码、name 中文名、note 规格说明），没有地区概念的套餐（点数档等）为 null。display_name 是拼好地区的展示名。region_confirmation_required 为 true 时，下单要带 region_confirmed=true，建议让买家在页面上确认一次地区。" },
        { kind: "p", text: "kind 是 cdk（卡密）或 account（成品号）。available 为 false 表示成品号暂时缺货，stock 是成品号剩余数量，卡密为 null。store.open 为 false 时全站暂停售卖，下单会失败，请把 store.closed_reason 显示给买家。store.max_quantity 是单笔最多张数，store.payment_channels 是现在能用的支付方式。" },
        { kind: "code", text: `curl -H "Authorization: Bearer km_live_你的Key" \\\n  ${base}/plans` },
        {
          kind: "code",
          text: `{
  "data": {
    "store": {
      "open": true,
      "closed_reason": "",
      "max_quantity": 10,
      "payment_channels": ["alipay", "wxpay"]
    },
    "plans": [
      {
        "plan_key": "pro_20x:us",
        "base_plan_key": "pro_20x",
        "payment_country": "US",
        "region": { "code": "US", "name": "美区", "name_en": "United States", "note": "" },
        "name": "Pro",
        "display_name": "Pro · 美区",
        "description": "",
        "category": "",
        "name_en": "Pro",
        "cover_url": "https://.../storefront/cover-pro.png",
        "kind": "cdk",
        "available": true,
        "stock": null,
        "region_confirmation_required": true,
        "cost_cents": 1000,
        "retail_price_cents": 1500,
        "currency": "CNY"
      }
    ]
  },
  "request_id": "req_..."
}`,
        },
        { kind: "p", text: "商品列表变化不频繁，建议在你的服务端缓存 1 到 5 分钟，不要每个买家访问都调一次。" },
      ],
    },
    {
      id: "orders",
      title: "GET /orders  查订单",
      blocks: [
        { kind: "p", text: "权限 orders:read。本店销售订单，按 id 从新到旧。limit 默认 20，最大 100。还有下一页时 page.has_more 为 true，把 page.next_cursor 原样放到下一次的 cursor。" },
        {
          kind: "table",
          headers: ["参数", "位置", "说明"],
          rows: [
            ["limit", "query", "每页条数，1 到 100，默认 20"],
            ["cursor", "query", "上一页返回的 next_cursor，不传则从最新开始"],
            ["pay_status", "query", "按支付状态过滤：unpaid、paid、closed（未付款 30 分钟自动关闭）"],
            ["customer_email", "query", "只看某个买家邮箱的订单，大小写不敏感。做「按邮箱查订单」用这个"],
          ],
        },
        { kind: "code", text: `curl -H "Authorization: Bearer km_live_你的Key" \\\n  "${base}/orders?limit=20&pay_status=paid"` },
        {
          kind: "code",
          text: `{
  "data": {
    "orders": [
      {
        "order_no": "KS202609240001",
        "plan_key": "pro_20x",
        "product_name": "Pro",
        "quantity": 1,
        "gross_cents": 1500,
        "currency": "CNY",
        "customer_email": "buyer@example.com",
        "pay_status": "paid",
        "fulfill_status": "delivered",
        "created_at": "2026-09-24T05:00:00.000Z",
        "paid_at": "2026-09-24T05:01:00.000Z"
      }
    ],
    "page": { "next_cursor": "120", "has_more": true }
  },
  "request_id": "req_..."
}`,
        },
      ],
    },
    {
      id: "create-order",
      title: "POST /orders  代客下单",
      blocks: [
        { kind: "p", text: "权限 orders:write。用本店已分配且在售的套餐建一笔销售订单，并返回易支付链接。金额按你设的零售价乘张数，有券再减，要开票再加开票加价。调用方不能自己传金额。零售价低于成本，或扣完通道费后收益为负，不会生成链接。" },
        { kind: "p", text: "必须带 Idempotency-Key。同样的 Key 和同样的正文重复提交，返回第一次的支付链接。同一个 Key 配了不同正文返回 409。" },
        {
          kind: "table",
          headers: ["字段", "必填", "说明"],
          rows: [
            ["plan_key", "是", "GET /plans 返回的 plan_key，要精确到地区"],
            ["channel", "是", "alipay 或 wxpay"],
            ["customer_email", "是", "买家邮箱，发卡和查单用"],
            ["quantity", "否", "张数，默认 1，不能超过店铺的单笔上限"],
            ["region_confirmed", "多地区时必填", "同一套餐有两个及以上在售地区时必须为 true"],
            ["coupon_code", "否", "本店优惠券，或买家的邀请券（邀请券只能用发券的邮箱下单）"],
            ["referral_code", "否", "邀请码。买家从别人的邀请链接（?ref=…）进来时带上，首单发货并过冷静期后给邀请人发券"],
            ["return_url", "否", "买家付完款跳回的 https 地址，例如你自己站上的订单页。可以写 {order_no}，会换成本单单号。不传则跳回本站订单页"],
          ],
        },
        { kind: "code", text: `curl -X POST ${base}/orders \\\n  -H "Authorization: Bearer km_live_你的Key" \\\n  -H "Content-Type: application/json" \\\n  -H "Idempotency-Key: pay-1001" \\\n  -d "{\\"plan_key\\":\\"plus\\",\\"channel\\":\\"alipay\\",\\"customer_email\\":\\"buyer@example.com\\",\\"quantity\\":1,\\"return_url\\":\\"https://shop.example.com/orders/{order_no}\\"}"` },
        { kind: "code", text: `{ "data": { "order_no": "KS...", "pay_url": "https://...", "gross_cents": 17500, "currency": "CNY", "pay_status": "unpaid", "query_token": "..." }, "request_id": "req_..." }` },
        { kind: "p", text: "把 pay_url 交给买家。支付网关跳回 return_url 时会附带自己的参数，这些参数不能当作付款凭据：请以 order.paid 回调或 GET /orders/{orderNo} 的 pay_status 为准。未付款的订单 30 分钟后自动关闭，pay_status 变成 closed，需要重新下单。" },
      ],
    },
    {
      id: "quote",
      title: "POST /orders/quote  询价",
      blocks: [
        { kind: "p", text: "权限 orders:read。参数和 POST /orders 一样（plan_key、channel、quantity、coupon_code、invoice_requested，校验邀请券时再带 customer_email），只算钱，不建单、不占券，不需要 Idempotency-Key。用它在下单前显示实付金额，或校验买家输入的优惠券：券不能用时返回 VALIDATION_FAILED，message 可以直接给买家看。" },
        { kind: "code", text: `curl -X POST ${base}/orders/quote \\\n  -H "Authorization: Bearer km_live_你的Key" \\\n  -H "Content-Type: application/json" \\\n  -d "{\\"plan_key\\":\\"plus\\",\\"channel\\":\\"alipay\\",\\"quantity\\":2,\\"coupon_code\\":\\"NEW10\\"}"` },
        { kind: "code", text: `{ "data": { "list_goods_cents": 35000, "discount_cents": 1000, "goods_cents": 34000, "invoice_surcharge_cents": 0, "pay_cents": 34000, "coupon_code": "NEW10", "coupon_kind": "store", "currency": "CNY" }, "request_id": "req_..." }` },
      ],
    },
    {
      id: "order",
      title: "GET /orders/{orderNo}  单笔订单",
      blocks: [
        { kind: "p", text: "权限 orders:read。返回订单金额明细（list_goods_cents 原价、discount_cents 券减免、invoice_surcharge_cents 开票加价、gross_cents 实付）、地区 region、类型 kind 和已发出的卡。卡密默认脱敏，字段是 code_masked。别人的订单返回 404。" },
        { kind: "p", text: "加 ?reveal=1 一次取整单明文，需要 Key 同时有 cdks:reveal 权限，会写一条审计。卡密在 code 字段；成品号（kind=account）还会拆好放在 account 里：email、password、mailbox_password、session。一单多张时可能分批发出，fulfill_status 为 delivered 才算发齐。" },
        { kind: "code", text: `curl -H "Authorization: Bearer km_live_你的Key" \\\n  "${base}/orders/KS202609240001?reveal=1"` },
      ],
    },
    {
      id: "cdks",
      title: "GET /cdks  查卡密",
      blocks: [
        { kind: "p", text: "权限 cdks:read。本店已售出的卡和自助提卡提出的卡，默认脱敏。source 为 store 是店铺卖出，为 draw 是提卡提出，提卡的卡 order_no 为 null。payment_country 是卡实际的付款地区，region 格式和 /plans 相同，没有地区概念的套餐为 null。提卡领走的成品号不在这里列。" },
        {
          kind: "table",
          headers: ["参数", "位置", "说明"],
          rows: [
            ["limit", "query", "每页条数，1 到 100，默认 20"],
            ["cursor", "query", "上一页的 next_cursor"],
            ["status", "query", "unused、locked、used、disabled"],
            ["order_no", "query", "只看某一笔销售订单下的卡。带上它时不会返回提卡的卡"],
          ],
        },
        { kind: "code", text: `curl -H "Authorization: Bearer km_live_你的Key" \\\n  "${base}/cdks?status=unused&order_no=KS202609240001"` },
      ],
    },
    {
      id: "reveal",
      title: "POST /cdks/{id}/reveal  看明文",
      blocks: [
        { kind: "p", text: "权限 cdks:reveal。路径里的 id 是查卡密接口返回的 id。每次调用都会写审计。没有这个权限时创建 Key 不要勾「看卡密明文」。" },
        { kind: "code", text: `curl -X POST -H "Authorization: Bearer km_live_你的Key" \\\n  ${base}/cdks/18/reveal` },
        { kind: "code", text: `{ "data": { "id": 18, "code": "KM....", "status": "unused" }, "request_id": "req_..." }` },
      ],
    },
    {
      id: "redeem",
      title: "POST /redemptions  提交兑换",
      blocks: [
        { kind: "p", text: "权限 redeem:write。只能兑换本店卖出的卡。提交后马上返回兑换单号，真正开通在后台进行，用查询接口或回调拿最终结果。" },
        { kind: "p", text: "建议每次带一个新的 Idempotency-Key。同样的 Key 和同样的正文重复提交，会返回第一次的结果，不会建第二笔单。并发的第二个请求返回 409，正文是「请求处理中」。同一个 Key 配了不同正文也返回 409。" },
        {
          kind: "table",
          headers: ["字段", "必填", "说明"],
          rows: [
            ["code", "是", "卡密"],
            ["mode", "否", "只支持 session，可不传；邮箱密码方式已下线"],
            ["session", "是", "ChatGPT Session"],
          ],
        },
        {
          kind: "code",
          text: `curl -X POST ${base}/redemptions \\
  -H "Authorization: Bearer km_live_你的Key" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-1001" \\
  -d '{"code":"KM....","mode":"session","session":"..."}'`,
        },
        { kind: "p", text: "返回里带这张卡的 plan_key、payment_country 和 region（格式同 /plans），店铺卖的卡和提卡的卡都有。没有地区概念的套餐 region 为 null。" },
        { kind: "code", text: `{ "data": { "redemption_no": "RC202609240001", "status": "pending", "plan_key": "pro_20x:us", "payment_country": "US", "region": { "code": "US", "name": "美区", "name_en": "United States" } }, "request_id": "req_..." }` },
      ],
    },
    {
      id: "session-check",
      title: "POST /sessions/check  校验 Session",
      blocks: [
        { kind: "p", text: "权限 redeem:write，和提交兑换同一把 Key。买家提交兑换前，拿他贴的 Session 和要兑的卡密让卡台预检一次，和店铺兑换页的「校验 Session」是同一个检查。预检不消耗卡密，也不会开通；不对就当场让买家重贴，不用等兑换失败。" },
        {
          kind: "table",
          headers: ["字段", "必填", "说明"],
          rows: [
            ["session", "是", "买家从 chatgpt.com/api/auth/session 复制的整页内容"],
            ["code", "是", "要兑换的卡密，必须是本店卖出的"],
          ],
        },
        { kind: "p", text: "校验没过是正常结果：HTTP 200，data.ok 为 false，errors 里的话可以直接给买家看。只有参数不对、卡密不是本店卖出的才返回错误。拿不属于本店的卡密反复调用，会和提交兑换一样计入失败次数并被暂时封禁。Session 含登录凭证，本站不保存也不记日志。" },
        {
          kind: "code",
          text: `curl -X POST ${base}/sessions/check \\
  -H "Authorization: Bearer km_live_你的Key" \\
  -H "Content-Type: application/json" \\
  -d '{"session":"{...}","code":"KM...."}'`,
        },
        {
          kind: "code",
          text: `{
  "data": {
    "ok": true,
    "email": "buyer@example.com",
    "plan_hint": "free",
    "has_active_subscription": false,
    "error_code": null,
    "errors": [],
    "warnings": ["当前账号没有有效订阅。"]
  },
  "request_id": "req_..."
}`,
        },
      ],
    },
    {
      id: "redeem-get",
      title: "GET /redemptions/{no}  查兑换",
      blocks: [
        { kind: "p", text: "权限 redeem:read。no 是提交接口返回的 redemption_no。status 为 success 或 failed 即终态。timeline 是处理进度。payment_country、region 和提交接口相同。" },
        { kind: "code", text: `curl -H "Authorization: Bearer km_live_你的Key" \\\n  ${base}/redemptions/RC202609240001` },
      ],
    },
    {
      id: "webhook",
      title: "兑换结果回调",
      blocks: [
        { kind: "p", text: "回调地址填你自己服务器上的 https 接口，例如 https://api.example.com/hooks/kaimi。不要填店铺地址，也不要填本站地址。订单付款、发货，或兑换成功、失败后，本站会向这个地址 POST JSON。请在 10 秒内返回任意 2xx，否则视为失败。" },
        {
          kind: "table",
          headers: ["事件", "什么时候", "负载"],
          rows: [
            ["order.paid", "销售订单付款到账", "order_no、pay_status、fulfill_status、plan_key、payment_country、product_name、quantity、gross_cents、currency、customer_email、created_at、paid_at、delivered_at"],
            ["order.delivered", "销售订单的卡密或成品号全部发齐", "同 order.paid。负载不带卡密，收到后用 GET /orders/{orderNo}?reveal=1 取"],
            ["redemption.succeeded", "兑换成功（status=success）", "redemption_no、status、message、plan_key、payment_country、region、created_at"],
            ["redemption.failed", "兑换失败（status=failed）", "同上"],
            ["ping", "在「开放 API」页点「发送测试」", "event、message、sent_at。不能订阅，只用来测通"],
          ],
        },
        { kind: "p", text: "订单事件的负载里有 livemode：正式订单为 true，测试 Key 的沙箱订单为 false。接收端遇到不认识的事件名请也返回 2xx，以后可能会加新事件。" },
        { kind: "p", text: "「开放 API」页能看到最近 50 条投递：发没发、对方回了什么状态码、失败原因，可以看内容、手动重发，也可以点「发送测试」推一条 ping 测通地址和验签。" },
        { kind: "p", text: "保存地址时选要推送的事件，会给你一把 whsec_ 密钥，只显示一次。以前保存的地址只订阅了兑换事件，要收订单事件请重新保存一个地址。请求头 X-Kaimi-Event 是事件名，X-Kaimi-Signature 是 t=<unix秒>,v1=<hex>。v1 是用密钥对「时间戳.原始请求体」做 HMAC-SHA256。请用收到的原始 body 验签，不要先 JSON.parse 再重新序列化。时间戳和当前时间相差超过 5 分钟应拒绝。" },
        { kind: "p", text: "投递失败后按 1 分钟、5 分钟、30 分钟、2 小时、12 小时重试，一共 5 次。同一事件可能收到多次，订单用 order_no + event 做幂等，兑换用 redemption_no 做幂等。回调可能丢，关键状态请再用 GET /orders/{orderNo} 核对。" },
        {
          kind: "code",
          text: `POST https://api.example.com/hooks/kaimi
X-Kaimi-Event: redemption.succeeded
X-Kaimi-Signature: t=1700000000,v1=...
Content-Type: application/json

{
  "event": "redemption.succeeded",
  "redemption_no": "RC202609240001",
  "status": "success",
  "message": "",
  "plan_key": "pro_20x",
  "payment_country": "",
  "region": { "code": "PH", "name": "菲区", "name_en": "Philippines" },
  "created_at": "2026-09-24T05:00:00.000Z"
}`,
        },
      ],
    },
  ];
  if (!options?.includeDraw) return sections;
  return [...sections, ...drawApiDocs(base)];
}

function drawApiDocs(base: string): DocSection[] {
  return [
    {
      id: "draw-account",
      title: "GET /draws/account  额度和未结",
      blocks: [
        { kind: "p", text: "权限 draw:read。查看授信额度、还剩多少可提、未结算欠款，以及单次和每日张数。不用先提卡。金额单位是分。" },
        {
          kind: "table",
          headers: ["字段", "说明"],
          rows: [
            ["credit.limit_cents", "授信额度"],
            ["credit.available_cents", "还能提的金额。额度减去未结和正在出卡的金额"],
            ["credit.unsettled_cents", "已提出、还没结算的欠款"],
            ["credit.inflight_cents", "正在出卡、先占着的金额"],
            ["limits.max_per_draw", "单次最多张数"],
            ["limits.daily_limit", "每日最多张数，0 表示不限"],
            ["limits.today_count", "今天已经提出的张数，不含作废"],
            ["unsettled", "未结张数、金额，以及按套餐分开的明细"],
            ["lifetime", "历史提卡和已结算"],
            ["plans", "现在能提的套餐和单价"],
            ["plans[].fulfillment_kind", "cardplatform = 卡密；local_account = 成品号"],
            ["plans[].available_stock", "成品号现在最多能提几个；卡密为 null"],
          ],
        },
        { kind: "code", text: `curl -H "Authorization: Bearer km_live_你的Key" \\\n  ${base}/draws/account` },
        { kind: "p", text: "暂停提卡后仍能查额度和未结，但不能再提。授信由平台在后台调整，这个接口不能改额度。" },
      ],
    },
    {
      id: "draw",
      title: "POST /draws  提卡",
      blocks: [
        { kind: "p", text: "权限 draw:write。只有已开通提卡的代理可以调用。按你的提卡成本从卡台取卡，记入未结算账本，不走买家支付。调用方不能自己传价格。暂停提卡后这个接口会拒绝。" },
        { kind: "p", text: "必须带 Idempotency-Key，8 到 80 个字符。同一个 Key 对应同一笔提卡单。如果卡台上次还没返回，用同一个 Key 再提交会去取回这一笔。换成别的套餐或张数会返回 409。" },
        {
          kind: "table",
          headers: ["字段", "必填", "说明"],
          rows: [
            ["plan_key", "是", "已分配且可提的套餐，要精确到地区"],
            ["quantity", "是", "张数，不能超过单次上限和每日剩余"],
            ["region_confirmed", "多地区时必填", "同一套餐有两个及以上在售地区时必须为 true"],
          ],
        },
        { kind: "code", text: `curl -X POST ${base}/draws \\\n  -H "Authorization: Bearer km_live_你的Key" \\\n  -H "Content-Type: application/json" \\\n  -H "Idempotency-Key: draw-1001" \\\n  -d "{\\"plan_key\\":\\"plus\\",\\"quantity\\":1,\\"region_confirmed\\":true}"` },
        { kind: "p", text: "成功时 items 里是这次的卡密明文和 id。状态若是 issuing 或 unknown，卡可能还没齐，用查询接口看进度，再用 reveal 取明文。额度、单次和每日上限与网页提卡相同。" },
        { kind: "p", text: "成品号（fulfillment_kind = local_account）需要平台单独开通。库存不够时整单拒绝（409），不会只给一部分；成功时状态直接是 delivered。items[].code 是「邮箱----GPT密码----邮箱密码----Session」一行，另外 accounts 里拆好了 email、gpt_password、mailbox_password、session 四段。卡密单的 accounts 是空数组。" },
      ],
    },
    {
      id: "draw-get",
      title: "GET /draws/{drawNo}  查提卡单",
      blocks: [
        { kind: "p", text: "权限 draw:read。只返回状态、张数和金额，卡密打码不在这里。别人的提卡单返回 404。" },
        { kind: "code", text: `curl -H "Authorization: Bearer km_live_你的Key" \\\n  ${base}/draws/DR202610050001` },
      ],
    },
    {
      id: "draw-reveal",
      title: "POST /draws/items/{id}/reveal  看提卡明文",
      blocks: [
        { kind: "p", text: "权限 draw:reveal。id 是提卡成功时 items 里的 id。每次调用都写审计。不能用来结算、作废或核销，那些只在平台后台。" },
        { kind: "code", text: `curl -X POST -H "Authorization: Bearer km_live_你的Key" \\\n  ${base}/draws/items/18/reveal` },
      ],
    },
  ];
}

export function agentApiDocsMarkdown(origin: string, options?: { includeDraw?: boolean }) {
  const lines = [
    "# Kaimi 代理开放 API",
    "",
    `基础地址：${origin}/api/v1/open`,
    "",
  ];
  for (const section of agentApiDocs(origin, options)) {
    lines.push(`## ${section.title}`, "");
    for (const block of section.blocks) {
      if (block.kind === "p") lines.push(block.text, "");
      if (block.kind === "code") lines.push("```", block.text, "```", "");
      if (block.kind === "table") {
        lines.push(`| ${block.headers.join(" | ")} |`);
        lines.push(`| ${block.headers.map(() => "---").join(" | ")} |`);
        for (const row of block.rows) lines.push(`| ${row.join(" | ")} |`);
        lines.push("");
      }
    }
  }
  return lines.join("\n");
}
