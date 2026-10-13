const errorSchema = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        code: {
          type: "string",
          enum: [
            "UNAUTHORIZED",
            "FORBIDDEN_SCOPE",
            "RATE_LIMITED",
            "VALIDATION_FAILED",
            "NOT_FOUND",
            "CONFLICT",
            "CDK_INVALID",
            "CDK_IN_FLIGHT",
            "REDEEM_BLOCKED",
            "INTERNAL",
          ],
        },
        message: { type: "string" },
      },
      required: ["code", "message"],
    },
    request_id: { type: "string" },
  },
  required: ["error", "request_id"],
};

const pageSchema = {
  type: "object",
  properties: {
    next_cursor: { type: ["string", "null"] },
    has_more: { type: "boolean" },
  },
};

function ok(dataSchema: object) {
  return {
    description: "成功",
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: { data: dataSchema, request_id: { type: "string" } },
          required: ["data", "request_id"],
        },
      },
    },
  };
}

const errorResponse = {
  description: "失败",
  content: { "application/json": { schema: errorSchema } },
};

const limitParam = {
  name: "limit",
  in: "query",
  schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
};
const cursorParam = { name: "cursor", in: "query", schema: { type: "string" } };

/** POST /orders 和 /orders/quote 的请求体。询价不需要买家邮箱和跳回地址。 */
function orderInputSchema(forOrder: boolean) {
  return {
    type: "object",
    required: forOrder ? ["plan_key", "channel", "customer_email"] : ["plan_key", "channel"],
    properties: {
      plan_key: { type: "string" },
      channel: { type: "string", enum: ["alipay", "wxpay"] },
      quantity: { type: "integer", minimum: 1 },
      coupon_code: { type: "string" },
      invoice_requested: { type: "boolean" },
      ...(forOrder
        ? {
            customer_email: { type: "string", format: "email" },
            region_confirmed: { type: "boolean", description: "region_confirmation_required 为 true 时必须为 true" },
            return_url: {
              type: "string",
              description: "付款后跳回的 https 地址，可含 {order_no}；不传跳回本站订单页",
            },
          }
        : {}),
    },
  };
}

export const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "Kaimi 代理开放 API",
    version: "1.0.0",
    description:
      "代理用 API Key 查询自己店铺的套餐、订单、卡密，并代客户提交兑换。金额单位为分，时间为 UTC。限流按单把 Key 在当前进程内计数，多台服务器不会加总。销售订单付款、发齐，以及兑换进入成功或失败时，可向代理配置的 https 地址推送 order.paid / order.delivered / redemption.succeeded / redemption.failed，签名头 X-Kaimi-Signature 为 t=<unix>,v1=<HMAC-SHA256(secret, t + '.' + body)>。",
  },
  servers: [{ url: "/api/v1/open" }],
  components: {
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
  },
  security: [{ bearer: [] }],
  webhooks: {
    order: {
      post: {
        summary: "销售订单付款到账（order.paid）或全部发齐（order.delivered）时 POST",
        description:
          "签名和重试与 redemption 相同。负载不带卡密，收到后用 GET /orders/{orderNo}?reveal=1 取。同一事件可能重复投递，用 order_no + event 去重。",
        parameters: [
          { name: "X-Kaimi-Event", in: "header", required: true, schema: { type: "string", enum: ["order.paid", "order.delivered"] } },
          { name: "X-Kaimi-Signature", in: "header", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  event: { type: "string", enum: ["order.paid", "order.delivered"] },
                  livemode: { type: "boolean", description: "正式订单 true；测试 Key 的沙箱订单 false" },
                  order_no: { type: "string" },
                  pay_status: { type: "string" },
                  fulfill_status: { type: "string" },
                  plan_key: { type: "string" },
                  payment_country: { type: "string" },
                  product_name: { type: "string" },
                  quantity: { type: "integer" },
                  gross_cents: { type: "integer" },
                  currency: { type: "string" },
                  customer_email: { type: "string" },
                  created_at: { type: "string" },
                  paid_at: { type: ["string", "null"] },
                  delivered_at: { type: ["string", "null"] },
                },
                required: ["event", "order_no", "pay_status", "fulfill_status"],
              },
            },
          },
        },
        responses: { "200": { description: "接收成功。任何 2xx 都视为投递成功。" } },
      },
    },
    redemption: {
      post: {
        summary: "兑换进入成功或失败时，向代理填写的 https 地址 POST",
        description:
          "请求头 X-Kaimi-Event 为事件名。X-Kaimi-Signature 为 t=<unix秒>,v1=<HMAC-SHA256(secret, t + '.' + 原始body)>。接收方须在 5 分钟内用原始 body 验签，并返回 2xx。失败后按 1 分钟、5 分钟、30 分钟、2 小时、12 小时重试，共 5 次。",
        parameters: [
          { name: "X-Kaimi-Event", in: "header", required: true, schema: { type: "string", enum: ["redemption.succeeded", "redemption.failed"] } },
          { name: "X-Kaimi-Signature", in: "header", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  event: { type: "string", enum: ["redemption.succeeded", "redemption.failed"] },
                  redemption_no: { type: "string" },
                  status: { type: "string", enum: ["success", "failed"] },
                  message: { type: "string" },
                  plan_key: { type: "string" },
                  created_at: { type: "string" },
                },
                required: ["event", "redemption_no", "status"],
              },
            },
          },
        },
        responses: { "200": { description: "接收成功。任何 2xx 都视为投递成功。" } },
      },
    },
  },
  paths: {
    "/plans": {
      get: {
        summary: "本店现在能下单的套餐，和店铺页一致",
        responses: {
          "200": ok({
            type: "object",
            properties: {
              store: {
                type: "object",
                description: "只有代理 Key 返回",
                properties: {
                  open: { type: "boolean", description: "false 表示全站暂停售卖，下单会失败" },
                  closed_reason: { type: "string", description: "暂停时给买家看的说明" },
                  max_quantity: { type: "integer", description: "单笔最多张数" },
                  payment_channels: { type: "array", items: { type: "string", enum: ["alipay", "wxpay"] } },
                },
              },
              plans: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    plan_key: { type: "string" },
                    base_plan_key: { type: "string", description: "同一套餐不同地区共用的分组键" },
                    payment_country: { type: "string", description: "卡台付款地区两位码。空串 = 菲区或无地区" },
                    region: {
                      type: ["object", "null"],
                      description: "付款地区。点数档、续费档、成品号等没有地区概念的套餐为 null",
                      properties: {
                        code: { type: "string", description: "地区短码，如 PH / US / CL" },
                        name: { type: "string", description: "地区中文名，如 菲区 / 美区" },
                        name_en: { type: "string" },
                        note: { type: "string", description: "该地区规格的一句话说明，可能为空" },
                      },
                    },
                    name: { type: "string" },
                    display_name: { type: "string", description: "带地区的展示名，如 Plus · 美区；无地区时等于 name" },
                    description: { type: "string" },
                    category: { type: "string" },
                    name_en: { type: "string", description: "代理 Key：店铺装修里的英文名" },
                    cover_url: { type: "string", description: "代理 Key：封面图绝对地址，可能为空" },
                    kind: { type: "string", enum: ["cdk", "account"], description: "代理 Key：卡密或成品号" },
                    available: { type: "boolean", description: "代理 Key：false 表示成品号缺货" },
                    stock: { type: ["integer", "null"], description: "代理 Key：成品号剩余数量，卡密为 null" },
                    region_confirmation_required: { type: "boolean", description: "代理 Key：下单必须带 region_confirmed=true" },
                    cost_cents: { type: "integer" },
                    retail_price_cents: { type: "integer" },
                    currency: { type: "string" },
                  },
                },
              },
            },
          }),
          "401": errorResponse,
        },
      },
    },
    "/orders": {
      get: {
        summary: "本店销售订单，游标分页",
        parameters: [
          limitParam,
          cursorParam,
          { name: "pay_status", in: "query", schema: { type: "string", enum: ["unpaid", "paid", "closed"] } },
          { name: "customer_email", in: "query", schema: { type: "string" }, description: "按买家邮箱过滤，大小写不敏感" },
        ],
        responses: {
          "200": ok({
            type: "object",
            properties: {
              orders: { type: "array", items: { type: "object" } },
              page: pageSchema,
            },
          }),
          "401": errorResponse,
        },
      },
      post: {
        summary: "代客下单，按代理零售价返回易支付链接",
        description:
          "未付款订单 30 分钟后自动关闭（pay_status=closed）。测试 Key（km_test_）下单只进沙箱：订单号 KT 开头，pay_url 打开即模拟付款成功并发假卡，返回里 livemode=false。",
        parameters: [{ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: orderInputSchema(true) } } },
        responses: {
          "200": ok({
            type: "object",
            properties: {
              order_no: { type: "string" },
              pay_url: { type: "string" },
              gross_cents: { type: "integer" },
              currency: { type: "string" },
              pay_status: { type: "string" },
              query_token: { type: "string" },
            },
          }),
          "400": errorResponse,
          "403": errorResponse,
          "409": errorResponse,
        },
      },
    },
    "/orders/quote": {
      post: {
        summary: "询价：算实付金额、校验优惠券，不建单不占券。需要 orders:read",
        requestBody: { required: true, content: { "application/json": { schema: orderInputSchema(false) } } },
        responses: {
          "200": ok({
            type: "object",
            properties: {
              list_goods_cents: { type: "integer" },
              discount_cents: { type: "integer" },
              goods_cents: { type: "integer" },
              invoice_surcharge_cents: { type: "integer" },
              pay_cents: { type: "integer" },
              coupon_code: { type: "string" },
              currency: { type: "string" },
            },
          }),
          "400": errorResponse,
          "403": errorResponse,
        },
      },
    },
    "/draws/account": {
      get: {
        summary: "提卡授信、可用额度和未结欠款",
        responses: { "200": ok({ type: "object" }), "403": errorResponse },
      },
    },
    "/draws": {
      get: { summary: "提卡单列表，不含卡密明文", responses: { "200": ok({ type: "object" }), "403": errorResponse } },
      post: {
        summary: "提卡，按代理成本取卡",
        parameters: [{ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } }],
        responses: { "200": ok({ type: "object" }), "400": errorResponse, "403": errorResponse, "409": errorResponse },
      },
    },
    "/draws/{drawNo}": {
      get: {
        summary: "单笔提卡单，不含卡密明文",
        parameters: [{ name: "drawNo", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": ok({ type: "object" }), "404": errorResponse },
      },
    },
    "/draws/items/{id}/reveal": {
      post: {
        summary: "查看一张提卡卡密明文，并写审计",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: { "200": ok({ type: "object" }), "404": errorResponse },
      },
    },
    "/orders/{orderNo}": {
      get: {
        summary: "单笔订单，卡密默认脱敏；reveal=1 且有 cdks:reveal 权限时返回整单明文",
        parameters: [
          { name: "orderNo", in: "path", required: true, schema: { type: "string" } },
          { name: "reveal", in: "query", schema: { type: "string", enum: ["1"] } },
        ],
        responses: {
          "200": ok({
            type: "object",
            properties: {
              order_no: { type: "string" },
              plan_key: { type: "string" },
              payment_country: { type: "string" },
              region: {
                type: ["object", "null"],
                properties: { code: { type: "string" }, name: { type: "string" }, name_en: { type: "string" } },
              },
              kind: { type: "string", enum: ["cdk", "account"] },
              product_name: { type: "string" },
              quantity: { type: "integer" },
              list_goods_cents: { type: "integer" },
              discount_cents: { type: "integer" },
              coupon_code: { type: "string" },
              invoice_surcharge_cents: { type: "integer" },
              gross_cents: { type: "integer" },
              currency: { type: "string" },
              customer_email: { type: "string" },
              pay_status: { type: "string" },
              fulfill_status: { type: "string" },
              created_at: { type: "string" },
              paid_at: { type: ["string", "null"] },
              delivered_at: { type: ["string", "null"] },
              cdks: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "integer" },
                    status: { type: "string" },
                    plan_key: { type: "string" },
                    payment_country: { type: "string" },
                    code_masked: { type: "string" },
                    code: { type: "string", description: "仅 reveal=1" },
                    account: {
                      type: ["object", "null"],
                      description: "仅 reveal=1 且 kind=account",
                      properties: {
                        email: { type: "string" },
                        password: { type: "string" },
                        mailbox_password: { type: "string" },
                        session: { type: "string" },
                      },
                    },
                    issued_at: { type: "string" },
                    used_at: { type: ["string", "null"] },
                  },
                },
              },
            },
          }),
          "404": errorResponse,
        },
      },
    },
    "/cdks": {
      get: {
        summary: "本店已售卡密",
        parameters: [
          limitParam,
          cursorParam,
          { name: "status", in: "query", schema: { type: "string" } },
          { name: "order_no", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": ok({
            type: "object",
            properties: {
              cdks: { type: "array", items: { type: "object" } },
              page: pageSchema,
            },
          }),
        },
      },
    },
    "/cdks/{id}/reveal": {
      post: {
        summary: "读取卡密明文，需要 cdks:reveal",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: {
          "200": ok({
            type: "object",
            properties: { id: { type: "integer" }, code: { type: "string" } },
          }),
          "403": errorResponse,
          "404": errorResponse,
        },
      },
    },
    "/redemptions": {
      post: {
        summary: "提交兑换，只能兑本店卖出的卡",
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            schema: { type: "string" },
            description: "相同内容重复提交返回第一次的结果。并发时第二个请求返回 409。",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  code: { type: "string" },
                  mode: { type: "string", enum: ["session", "mailbox"] },
                  session: { type: "string" },
                  email: { type: "string" },
                  password: { type: "string" },
                },
                required: ["code"],
              },
            },
          },
        },
        responses: {
          "200": ok({
            type: "object",
            properties: {
              redemption_no: { type: "string" },
              status: { type: "string" },
            },
          }),
          "400": errorResponse,
          "409": errorResponse,
          "429": errorResponse,
        },
      },
    },
    "/redemptions/{no}": {
      get: {
        summary: "查询兑换状态和进度",
        parameters: [{ name: "no", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": ok({
            type: "object",
            properties: {
              redemption_no: { type: "string" },
              status: { type: "string" },
              message: { type: "string" },
              plan_key: { type: "string" },
              timeline: { type: "array", items: { type: "object" } },
            },
          }),
          "404": errorResponse,
        },
      },
    },
  },
};
