/**
 * 状态文案的唯一来源。
 *
 * 之前 4 个页面各有一份映射表，都写成 `MAP[value] || value`，所以任何没被收录的
 * 状态都会把英文枚举值直接显示给客户和代理（`manual_review`、`pending_payment`、
 * `unused`）。这里收口，并且分清两种受众：客户绝不能看到原始值，管理员反而需要看到，
 * 出问题时那串英文就是线索。
 */

const CDK_STATUS: Record<string, string> = {
  unused: "未使用",
  locked: "占用中",
  redeeming: "兑换中",
  used: "已使用",
  sold: "已售出",
  disabled: "已禁用",
  frozen: "已冻结",
  reserved: "已预留",
  consumed: "已使用",
};

const PAY_STATUS: Record<string, string> = {
  paid: "已支付",
  unpaid: "未支付",
  pending_pay: "待支付",
  refunded: "已退款",
  refunding: "退款中",
  chargeback: "已拒付",
  manual: "手工登记",
};

const FULFILL_STATUS: Record<string, string> = {
  pending: "等待中",
  issuing: "发卡中",
  preparing: "准备中",
  submitted: "已提交",
  processing: "处理中",
  delivered: "已发卡",
  paid_undelivered: "已付未发",
  fulfilled: "已完成",
  success: "已成功",
  failed: "失败",
  skipped: "无需处理",
  unknown: "核对中",
  running: "处理中",
  expired: "已过期",
  cancelled: "已取消",
};

/** 手续费是支付渠道实收还是按后台费率估算的。代理要看懂这一栏。 */
const FEE_STATUS: Record<string, string> = {
  confirmed: "支付渠道实收",
  unsupported: "按费率估算",
  pending: "核对中",
  retrying: "核对中",
  manual_review: "待人工核对",
};

const SETTLEMENT_STATUS: Record<string, string> = {
  pending_payment: "待返佣",
  paid: "已返佣",
  cancelled: "已撤销",
};

const JOB_STATUS: Record<string, string> = {
  pending: "排队中",
  running: "处理中",
  succeeded: "已完成",
  failed: "失败",
  retrying: "重试中",
};

const ALL: Record<string, string> = {
  ...CDK_STATUS,
  ...PAY_STATUS,
  ...FULFILL_STATUS,
  ...SETTLEMENT_STATUS,
  ...JOB_STATUS,
};

export type StatusDomain =
  | "cdk"
  | "pay"
  | "fulfill"
  | "fee"
  | "settlement"
  | "job"
  | "any";

const DOMAINS: Record<StatusDomain, Record<string, string>> = {
  cdk: CDK_STATUS,
  pay: PAY_STATUS,
  fulfill: FULFILL_STATUS,
  fee: FEE_STATUS,
  settlement: SETTLEMENT_STATUS,
  job: JOB_STATUS,
  any: ALL,
};

/** 客户和代理页面用：认不出来就说「处理中」，绝不把英文枚举值抖出去。 */
export function publicStatusLabel(value: string, domain: StatusDomain = "any") {
  const key = (value || "").trim();
  if (!key) return "—";
  return DOMAINS[domain][key] || "处理中";
}

/** 管理员页面用：认不出来保留原值，那串英文是排查线索。 */
export function adminStatusLabel(value: string, domain: StatusDomain = "any") {
  const key = (value || "").trim();
  if (!key) return "—";
  return DOMAINS[domain][key] || key;
}
