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

export const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "Kaimi 代理开放 API",
    version: "1.0.0",
    description:
      "代理用 API Key 查询自己店铺的套餐、订单、卡密，并代客户提交兑换。金额单位为分，时间为 UTC。限流按单把 Key 在当前进程内计数，多台服务器不会加总。兑换进入成功或失败时，可向代理配置的 https 地址推送 redemption.succeeded / redemption.failed，签名头 X-Kaimi-Signature 为 t=<unix>,v1=<HMAC-SHA256(secret, t + '.' + body)>。",
  },
  servers: [{ url: "/api/v1/open" }],
  components: {
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
  },
  security: [{ bearer: [] }],
  webhooks: {
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
        summary: "已分配且启用的套餐",
        responses: {
          "200": ok({
            type: "object",
            properties: {
              plans: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    plan_key: { type: "string" },
                    name: { type: "string" },
                    description: { type: "string" },
                    category: { type: "string" },
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
          { name: "pay_status", in: "query", schema: { type: "string" } },
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
    },
    "/orders/{orderNo}": {
      get: {
        summary: "单笔订单，卡密默认脱敏",
        parameters: [{ name: "orderNo", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": ok({
            type: "object",
            properties: {
              order_no: { type: "string" },
              plan_key: { type: "string" },
              product_name: { type: "string" },
              quantity: { type: "integer" },
              gross_cents: { type: "integer" },
              pay_status: { type: "string" },
              fulfill_status: { type: "string" },
              cdks: { type: "array", items: { type: "object" } },
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
