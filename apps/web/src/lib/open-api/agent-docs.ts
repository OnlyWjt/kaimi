export type DocBlock =
  | { kind: "p"; text: string }
  | { kind: "code"; text: string }
  | { kind: "table"; headers: string[]; rows: string[][] };

export type DocSection = {
  id: string;
  title: string;
  blocks: DocBlock[];
};

export function agentApiDocs(origin: string): DocSection[] {
  const base = `${origin}/api/v1/open`;
  return [
    {
      id: "auth",
      title: "调用约定",
      blocks: [
        { kind: "p", text: `基础地址 ${base}。每个请求都要带请求头 Authorization: Bearer km_live_你的Key。Key 只在创建时显示一次，丢了只能吊销后重建。` },
        { kind: "p", text: "代理 Key 只能看到自己店铺的套餐、订单和卡密，也只能兑换自己卖出的卡。金额单位是分，时间是 UTC。" },
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
}

export function agentApiDocsMarkdown(origin: string) {
  const lines = [
    "# Kaimi 代理开放 API",
    "",
    `基础地址：${origin}/api/v1/open`,
    "",
  ];
  for (const section of agentApiDocs(origin)) {
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
