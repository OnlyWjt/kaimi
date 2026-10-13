# 代理代客支付 API

确认日期：2026-10-04。按这个实现。

## 做什么

代理把 Key 给自己的系统。对方调用本站开放 API，为本店已分配的套餐创建销售订单，拿到易支付链接。买家付款进本站已配置的易支付商户。本站负责发卡。这不是把易支付借成通用收款，调用方不能自己填金额。

## 接口

`POST /api/v1/open/orders`

权限：`orders:write`。只接受代理 Key。平台 Key 返回 403。

请求头：

- `Authorization: Bearer km_live_...`
- `Idempotency-Key` 必填。相同 Key 和相同正文重放第一次的结果。不同正文返回 409。

正文：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| plan_key | 是 | `GET /plans` 里的 key，精确到地区 |
| channel | 是 | `alipay` 或 `wxpay` |
| customer_email | 是 | 买家邮箱 |
| quantity | 否 | 默认 1，不超过店铺单笔上限 |
| region_confirmed | 多地区时 | 同一套餐有两个及以上在售地区时必须为 true |
| coupon_code | 否 | 本店优惠券 |

成功 `data`：`order_no`、`pay_url`、`gross_cents`、`pay_status`、`query_token`。

金额用代理零售价，下单时记下手续费和代理收益。之后改费率不改这笔。收益为负则拒绝。只能卖该代理已分配且启用的套餐。易支付异步通知仍然只打到本站 `/api/webhooks/epay`。付完用现有 `GET /orders/{orderNo}` 看支付和发卡状态。
