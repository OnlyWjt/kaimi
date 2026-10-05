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
        { kind: "p", text: "代理 Key 只能操作自己的店铺：查套餐和订单、代客下单、看卡密、兑换自己卖出的卡。已开通提卡的代理还能用提卡接口。金额单位是分，时间是 UTC。代客下单的价格是你自己设的零售价。" },
        { kind: "p", text: "成功时 HTTP 200，正文是 { \"data\": ..., \"request_id\": \"req_...\" }。失败时 HTTP 状态码对应错误，正文是 { \"error\": { \"code\", \"message\" }, \"request_id\" }。排错时把 request_id 留着。" },
        {
          kind: "table",
          headers: ["错误码", "HTTP", "含义"],
          rows: [
            ["UNAUTHORIZED", "401", "没带 Key、Key 已吊销，或代理已被停用"],
            ["FORBIDDEN_SCOPE", "403", "这把 Key 没有该权限，或来源 IP 不在白名单"],
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
      id: "plans",
      title: "GET /plans  查套餐",
      blocks: [
        { kind: "p", text: "权限 plans:read。返回本店已启用的套餐。cost_cents 是你的成本，retail_price_cents 是你设的零售价。" },
        { kind: "code", text: `curl -H "Authorization: Bearer km_live_你的Key" \\\n  ${base}/plans` },
        {
          kind: "code",
          text: `{
  "data": {
    "plans": [
      {
        "plan_key": "pro_20x",
        "name": "Pro",
        "description": "",
        "category": "",
        "cost_cents": 1000,
        "retail_price_cents": 1500,
        "currency": "CNY"
      }
    ]
  },
  "request_id": "req_..."
}`,
        },
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
            ["pay_status", "query", "按支付状态过滤，例如 paid、unpaid"],
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
            ["coupon_code", "否", "本店优惠券"],
          ],
        },
        { kind: "code", text: `curl -X POST ${base}/orders \\\n  -H "Authorization: Bearer km_live_你的Key" \\\n  -H "Content-Type: application/json" \\\n  -H "Idempotency-Key: pay-1001" \\\n  -d "{\\"plan_key\\":\\"plus\\",\\"channel\\":\\"alipay\\",\\"customer_email\\":\\"buyer@example.com\\",\\"quantity\\":1}"` },
        { kind: "code", text: `{ "data": { "order_no": "KS...", "pay_url": "https://...", "gross_cents": 17500, "pay_status": "unpaid" }, "request_id": "req_..." }` },
        { kind: "p", text: "把 pay_url 交给买家。付完后用 GET /orders/{orderNo} 看 pay_status 和 fulfill_status。卡密仍然默认脱敏。支付通知只打到本站，不会打到调用方。" },
      ],
    },
    {
      id: "order",
      title: "GET /orders/{orderNo}  单笔订单",
      blocks: [
        { kind: "p", text: "权限 orders:read。卡密默认脱敏，字段是 code_masked。要明文请再调 reveal。别人的订单返回 404。" },
        { kind: "code", text: `curl -H "Authorization: Bearer km_live_你的Key" \\\n  ${base}/orders/KS202609240001` },
      ],
    },
    {
      id: "cdks",
      title: "GET /cdks  查卡密",
      blocks: [
        { kind: "p", text: "权限 cdks:read。本店已售出的卡，默认脱敏。" },
        {
          kind: "table",
          headers: ["参数", "位置", "说明"],
          rows: [
            ["limit", "query", "每页条数，1 到 100，默认 20"],
            ["cursor", "query", "上一页的 next_cursor"],
            ["status", "query", "unused、locked、used、disabled"],
            ["order_no", "query", "只看某一笔销售订单下的卡"],
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
            ["mode", "否", "session 或 mailbox，默认 session"],
            ["session", "session 时必填", "ChatGPT Session"],
            ["email", "mailbox 时必填", "账号邮箱"],
            ["password", "mailbox 时必填", "邮箱密码"],
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
        { kind: "code", text: `{ "data": { "redemption_no": "RC202609240001", "status": "pending" }, "request_id": "req_..." }` },
      ],
    },
    {
      id: "redeem-get",
      title: "GET /redemptions/{no}  查兑换",
      blocks: [
        { kind: "p", text: "权限 redeem:read。no 是提交接口返回的 redemption_no。status 为 success 或 failed 即终态。timeline 是处理进度。" },
        { kind: "code", text: `curl -H "Authorization: Bearer km_live_你的Key" \\\n  ${base}/redemptions/RC202609240001` },
      ],
    },
    {
      id: "webhook",
      title: "兑换结果回调",
      blocks: [
        { kind: "p", text: "回调地址填你自己服务器上的 https 接口，例如 https://api.example.com/hooks/kaimi。不要填店铺地址，也不要填本站地址。兑换进入成功或失败后，本站会向这个地址 POST JSON。请在 10 秒内返回任意 2xx，否则视为失败。" },
        { kind: "p", text: "事件只有两个：redemption.succeeded（status=success）和 redemption.failed（status=failed）。保存地址时会给你一把 whsec_ 密钥，只显示一次。请求头 X-Kaimi-Event 是事件名，X-Kaimi-Signature 是 t=<unix秒>,v1=<hex>。v1 是用密钥对「时间戳.原始请求体」做 HMAC-SHA256。请用收到的原始 body 验签，不要先 JSON.parse 再重新序列化。时间戳和当前时间相差超过 5 分钟应拒绝。" },
        { kind: "p", text: "投递失败后按 1 分钟、5 分钟、30 分钟、2 小时、12 小时重试，一共 5 次。同一笔兑换可能收到多次相同事件，请用 redemption_no 做幂等。" },
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
