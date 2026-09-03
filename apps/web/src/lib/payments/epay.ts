import { createHash, timingSafeEqual } from "node:crypto";
import type { PaymentChannel } from "./fees";

export type EpaySignMode = "append" | "key_param";

export type EpayConfig = {
  apiBase: string;
  pid: string;
  key: string;
  signMode?: EpaySignMode;
};

export type EpayOrderQuery = {
  paid: boolean;
  tradeNo: string;
  outTradeNo: string;
  channel: PaymentChannel | null;
  moneyCents: number;
  actualFeeCents: number | null;
  feeSupported: boolean;
  raw: Record<string, unknown>;
};

function normalizedBase(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function signBase(params: Record<string, string>) {
  return Object.entries(params)
    .filter(
      ([key, value]) =>
        key !== "sign" && key !== "sign_type" && value.trim() !== "",
    )
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, value]) => `${key}=${value.trim()}`)
    .join("&");
}

export function signEpayParams(
  params: Record<string, string>,
  merchantKey: string,
  mode: EpaySignMode = "append",
) {
  const base = signBase(params);
  const suffix =
    mode === "key_param"
      ? `&key=${merchantKey.trim()}`
      : merchantKey.trim();
  return createHash("md5").update(base + suffix, "utf8").digest("hex");
}

export function verifyEpayNotify(
  config: EpayConfig,
  params: Record<string, string>,
) {
  const got = params.sign?.trim();
  if (!got) return { ok: false as const, error: "missing sign" };
  const expected = signEpayParams(
    params,
    config.key,
    config.signMode ?? "append",
  );
  const gotBytes = Buffer.from(got.toLowerCase(), "utf8");
  const expectedBytes = Buffer.from(expected.toLowerCase(), "utf8");
  if (
    gotBytes.length !== expectedBytes.length ||
    !timingSafeEqual(gotBytes, expectedBytes)
  ) {
    return { ok: false as const, error: "invalid sign" };
  }
  if (params.pid && params.pid.trim() !== config.pid.trim()) {
    return { ok: false as const, error: "invalid pid" };
  }
  if (params.trade_status && params.trade_status !== "TRADE_SUCCESS") {
    return { ok: false as const, error: "trade not success" };
  }
  return { ok: true as const };
}

export function moneyYuan(cents: number) {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new Error("cents must be a non-negative safe integer");
  }
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function parseMoneyYuan(value: unknown) {
  const text = String(value ?? "").trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new Error("invalid money");
  const cents =
    Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(cents)) throw new Error("money is too large");
  return cents;
}

export async function createEpayPayment(
  config: EpayConfig,
  input: {
    outTradeNo: string;
    name: string;
    moneyCents: number;
    notifyUrl: string;
    returnUrl: string;
    channel: PaymentChannel;
    clientIp?: string;
  },
) {
  const params: Record<string, string> = {
    pid: config.pid.trim(),
    type: input.channel,
    out_trade_no: input.outTradeNo.trim(),
    notify_url: input.notifyUrl.trim(),
    return_url: input.returnUrl.trim(),
    name: [...input.name.trim()].slice(0, 127).join(""),
    money: moneyYuan(input.moneyCents),
    clientip: input.clientIp?.trim() || "127.0.0.1",
    device: "jump",
  };
  params.sign = signEpayParams(
    params,
    config.key,
    config.signMode ?? "append",
  );
  params.sign_type = "MD5";

  let response: Response;
  try {
    response = await fetch(`${normalizedBase(config.apiBase)}/mapi.php`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
  } catch {
    throw new Error("易支付下单网络请求失败，请稍后重试");
  }
  const text = await response.text();
  let raw: {
    code?: number;
    msg?: string;
    trade_no?: string;
    payurl?: string;
    qrcode?: string;
  } = {};
  if (text.trim()) {
    try {
      raw = JSON.parse(text) as typeof raw;
    } catch {
      throw new Error(
        text.includes("<")
          ? `易支付返回了网页而不是 JSON（HTTP ${response.status}）`
          : `易支付响应无效（HTTP ${response.status}）`,
      );
    }
  } else {
    throw new Error(`易支付没有返回内容（HTTP ${response.status}）`);
  }
  if (!response.ok || raw.code !== 1) {
    throw new Error(raw.msg?.trim() || `易支付下单失败（HTTP ${response.status}）`);
  }
  const payUrl = raw.payurl?.trim() || raw.qrcode?.trim();
  if (!payUrl) throw new Error("易支付未返回支付链接");
  return { tradeNo: raw.trade_no?.trim() || "", payUrl };
}

function channelFrom(value: unknown): PaymentChannel | null {
  return value === "alipay" || value === "wxpay" ? value : null;
}

function extractActualFee(raw: Record<string, unknown>) {
  for (const key of [
    "actual_fee",
    "actual_fee_money",
    "merchant_fee",
    "fee_money",
  ]) {
    const value = raw[key];
    if (value === undefined || value === null || value === "") continue;
    try {
      return parseMoneyYuan(value);
    } catch {
      throw new Error(`网关返回了无效的手续费字段 ${key}`);
    }
  }
  return null;
}

export async function queryEpayOrder(
  config: EpayConfig,
  input: { outTradeNo?: string; tradeNo?: string },
): Promise<EpayOrderQuery> {
  if (!input.outTradeNo && !input.tradeNo) {
    throw new Error("outTradeNo or tradeNo is required");
  }
  const query = new URLSearchParams({
    act: "order",
    pid: config.pid.trim(),
    key: config.key.trim(),
  });
  if (input.tradeNo) query.set("trade_no", input.tradeNo);
  else query.set("out_trade_no", input.outTradeNo!);

  let response: Response;
  try {
    response = await fetch(`${normalizedBase(config.apiBase)}/api.php`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: query.toString(),
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
  } catch {
    throw new Error("易支付查单网络请求失败");
  }
  const raw = (await response.json()) as Record<string, unknown>;
  if (!response.ok || Number(raw.code) !== 1) {
    throw new Error(String(raw.msg || `易支付查单失败（HTTP ${response.status}）`));
  }
  const actualFeeCents = extractActualFee(raw);
  return {
    paid: Number(raw.status) === 1,
    tradeNo: String(raw.trade_no || ""),
    outTradeNo: String(raw.out_trade_no || ""),
    channel: channelFrom(raw.type),
    moneyCents: parseMoneyYuan(raw.money),
    actualFeeCents,
    feeSupported: actualFeeCents !== null,
    raw,
  };
}
