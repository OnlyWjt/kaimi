/**
 * Folio 开票对接的纯函数部分：签名、查单映射、回调怎么回写、推单结果怎么处理。
 * 契约见 Folio 仓库 docs/integration-api.md，kaimi 侧设计见 docs/folio-invoice-integration.md。
 */
import crypto from "node:crypto";
import { yuanTextFromCents } from "@/lib/money";

export const FOLIO_ENABLED_SETTING = "folio_enabled";
export const FOLIO_BASE_URL_SETTING = "folio_base_url";
export const FOLIO_SECRET_SETTING = "folio_secret";

export const FOLIO_CALLBACK_PATH = "/api/v1/integrations/folio/callback";
export const FOLIO_PUSH_PATH = "/api/integration/v1/invoice-requests";
export const FOLIO_REFUND_PATH = "/api/integration/v1/refund-events";

/** 时间戳和服务器相差超过这么多秒就拒签。 */
export const FOLIO_MAX_SKEW_SECONDS = 300;
export const FOLIO_MIN_NONCE_LENGTH = 8;
/** nonce 在这段时间内不能重复。 */
export const FOLIO_NONCE_TTL_MS = 10 * 60_000;

/** 约定 §4.3 的自测向量（空 body）。 */
export const FOLIO_SELF_TEST_VECTOR = {
  method: "GET",
  path: "/api/v1/integrations/folio/orders/DJ1",
  ts: "1700000000",
  nonce: "ABC",
  body: "",
  secret: "secret",
  expected: "0134d6cae7d2a6c1fcc1dc1d9ea85bcee3cab9c1b3b45a1647230ee3b079a0e8",
} as const;

/** METHOD\nPATH\nTS\nNONCE\nHEX(SHA256(body))，HMAC-SHA256，小写 hex。 */
export function folioSign(
  method: string,
  path: string,
  ts: string,
  nonce: string,
  body: string | Buffer,
  secret: string,
) {
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  return crypto
    .createHmac("sha256", secret)
    .update(`${method.toUpperCase()}\n${path}\n${ts}\n${nonce}\n${bodyHash}`)
    .digest("hex");
}

export function folioSelfTest() {
  const v = FOLIO_SELF_TEST_VECTOR;
  const actual = folioSign(v.method, v.path, v.ts, v.nonce, v.body, v.secret);
  return { ok: actual === v.expected, expected: v.expected, actual };
}

/** 验签里不碰数据库的那部分：时间窗、nonce 长度、签名。nonce 是否重放由调用方查库。 */
export function checkFolioSignature(input: {
  method: string;
  path: string;
  body: string;
  secret: string;
  timestamp: string;
  nonce: string;
  signature: string;
  nowSeconds: number;
}): { ok: true } | { ok: false; error: string } {
  if (!/^\d{1,12}$/.test(input.timestamp)) return { ok: false, error: "时间戳无效" };
  if (Math.abs(input.nowSeconds - Number(input.timestamp)) > FOLIO_MAX_SKEW_SECONDS) {
    return { ok: false, error: "时间戳超出允许范围" };
  }
  if (input.nonce.length < FOLIO_MIN_NONCE_LENGTH) return { ok: false, error: "nonce 太短" };
  const expected = Buffer.from(
    folioSign(input.method, input.path, input.timestamp, input.nonce, input.body, input.secret),
  );
  const actual = Buffer.from(input.signature.trim().toLowerCase());
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return { ok: false, error: "签名不对" };
  }
  return { ok: true };
}

export const folioYuan = yuanTextFromCents;

type FolioOrderFacts = {
  orderNo: string;
  invoiceRequested: boolean;
  invoiceAmountCents: number;
  invoiceSurchargeCents: number;
  grossCents: number;
  payStatus: string;
  fulfillStatus: string;
  refundedAt: string | null;
  currency: string;
  invoiceTitle: string;
  invoiceTaxNo: string;
  invoiceEmail: string;
  invoiceNote: string;
  planKeySnapshot: string;
  productNameSnapshot: string;
  quantity: number;
};

/** 只有 ok 能开票，其它值 Folio 一律拒绝。 */
export function folioInvoiceableState(order: Pick<FolioOrderFacts, "invoiceRequested" | "payStatus" | "invoiceAmountCents">) {
  if (!order.invoiceRequested) return "not_requested";
  if (order.payStatus === "refunded" || order.payStatus === "chargeback") return "fully_refunded";
  if (order.payStatus === "refunding") return "refunding";
  if (order.payStatus === "paid") return order.invoiceAmountCents > 0 ? "ok" : "no_amount";
  return "unpaid";
}

export function folioFingerprint(order: Pick<FolioOrderFacts, "orderNo" | "invoiceAmountCents" | "payStatus" | "refundedAt">) {
  const raw = `${order.orderNo}|${order.invoiceAmountCents}|${order.payStatus}|${order.refundedAt ?? ""}`;
  return `sha256:${crypto.createHash("sha256").update(raw).digest("hex")}`;
}

function folioBuyer(order: FolioOrderFacts) {
  return {
    type: "company" as const,
    name: order.invoiceTitle,
    tax_no: order.invoiceTaxNo,
    email: order.invoiceEmail,
    note: order.invoiceNote,
  };
}

/** B 查单接口的 data。开票金额 = 买家实付（商品额 + 开票费），推单时带的金额也取这里。 */
export function folioOrderData(order: FolioOrderFacts) {
  const goodsCents = Math.max(0, order.grossCents - order.invoiceSurchargeCents);
  const refunded = order.payStatus === "refunded" || order.payStatus === "chargeback";
  return {
    order_no: order.orderNo,
    invoiceable: folioYuan(order.invoiceAmountCents),
    invoiceable_state: folioInvoiceableState(order),
    fingerprint: folioFingerprint(order),
    // 重复收款、关单后收款在 confirm-store-order 里已经拒绝，不会变成 paid
    has_payment_exception: false,
    consistent: order.invoiceAmountCents === order.grossCents,
    currency: order.currency,
    order_status: `${order.payStatus}/${order.fulfillStatus}`,
    total_amount: folioYuan(goodsCents),
    invoice_fee: folioYuan(order.invoiceSurchargeCents),
    customer_paid: folioYuan(order.grossCents),
    refunded: refunded ? folioYuan(order.grossCents) : "0.00",
    buyer: folioBuyer(order),
    items: [
      {
        product_id: order.planKeySnapshot,
        title: order.productNameSnapshot,
        quantity: order.quantity,
        net_amount: folioYuan(goodsCents),
      },
    ],
    note: order.invoiceNote,
  };
}

/** A 推单的 body。 */
export function folioPushBody(order: FolioOrderFacts) {
  return {
    order_no: order.orderNo,
    invoice_amount: folioYuan(order.invoiceAmountCents),
    buyer: folioBuyer(order),
  };
}

export type FolioEnvelope = { status_code: number; msg: string; data?: Record<string, unknown> };

export function parseFolioEnvelope(text: string): FolioEnvelope | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!value || typeof value !== "object" || typeof value.status_code !== "number") return null;
    return {
      status_code: value.status_code,
      msg: typeof value.msg === "string" ? value.msg : "",
      data: value.data && typeof value.data === "object" ? (value.data as Record<string, unknown>) : undefined,
    };
  } catch {
    return null;
  }
}

export type FolioPushOutcome =
  | { kind: "pushed"; invoiceId: string; duplicate: boolean }
  | { kind: "rejected"; error: string }
  | { kind: "unauthorized"; error: string }
  | { kind: "retry"; error: string };

function folioErrorText(httpStatus: number, envelope: FolioEnvelope | null) {
  return `Folio HTTP ${httpStatus}${envelope?.msg ? `：${envelope.msg}` : ""}`;
}

/** 推单结果：400/422 是 Folio 明确不收（金额不符、不可开、税号格式），不重试；401 是密钥或签名问题。 */
export function classifyFolioPush(httpStatus: number, envelope: FolioEnvelope | null): FolioPushOutcome {
  if (httpStatus === 200 && envelope?.status_code === 0) {
    const id = envelope.data?.invoice_id;
    return {
      kind: "pushed",
      invoiceId: id == null ? "" : String(id),
      duplicate: envelope.data?.duplicate === true,
    };
  }
  const error = folioErrorText(httpStatus, envelope);
  if (httpStatus === 400 || httpStatus === 422) return { kind: "rejected", error };
  if (httpStatus === 200) return { kind: "rejected", error };
  if (httpStatus === 401 || httpStatus === 403) {
    return { kind: "unauthorized", error: `${error}（检查两边的共用密钥和服务器时钟）` };
  }
  return { kind: "retry", error };
}

export const FOLIO_REFUND_ACTIONS = [
  "canceled",
  "red_flush",
  "red_pending",
  "already_reddened",
  "partial_refund_alert",
  "none",
] as const;

export function classifyFolioRefund(httpStatus: number, envelope: FolioEnvelope | null) {
  if (httpStatus === 200 && envelope?.status_code === 0) {
    const action = String(envelope.data?.action ?? "");
    return { ok: true as const, action: action || "none" };
  }
  return { ok: false as const, error: folioErrorText(httpStatus, envelope) };
}

export type FolioCallbackBody = {
  eventId: string;
  event: string;
  version: number;
  orderNo: string;
  invoiceId: string;
  previousInvoiceId: string;
  status: string;
  fphm: string;
  kprq: string;
  pdfUrl: string;
  redReasonCode: string;
  emailStatus: string;
};

function str(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

export function parseFolioCallback(value: unknown): FolioCallbackBody | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const version = Number(raw.version);
  const body: FolioCallbackBody = {
    eventId: str(raw.event_id),
    event: str(raw.event),
    version,
    orderNo: str(raw.order_no),
    invoiceId: str(raw.invoice_id),
    previousInvoiceId: str(raw.previous_invoice_id),
    status: str(raw.status),
    fphm: str(raw.fphm),
    kprq: str(raw.kprq),
    pdfUrl: str(raw.pdf_url),
    redReasonCode: str(raw.red_reason_code),
    emailStatus: str(raw.email_status),
  };
  if (!body.eventId || !body.event || !body.orderNo) return null;
  if (!Number.isSafeInteger(version) || version <= 0) return null;
  return body;
}

export type FolioNoticeKind = "issued" | "reissued" | "reddened";

export type FolioOrderPatch = {
  invoiceStatus?: string;
  invoiceNo?: string;
  invoiceIssuedAt?: string | null;
  folioInvoiceId?: string;
  invoicePdfUrl?: string;
  invoiceSyncVersion: number;
  folioPushStatus?: string;
  folioPushError?: string;
};

function httpsOnly(url: string) {
  return /^https:\/\//i.test(url) ? url.slice(0, 1000) : "";
}

/**
 * 一条回调要不要回写订单、写什么、要不要通知代理。
 * 版本号在同一订单号内单调递增（Folio F2），只接受比订单上新的；旧的只留记录、不通知。
 */
export function planFolioCallback(
  currentVersion: number,
  body: FolioCallbackBody,
): { applied: boolean; patch: FolioOrderPatch | null; noticeKind: FolioNoticeKind | "" } {
  if (body.version <= currentVersion) return { applied: false, patch: null, noticeKind: "" };
  const version = body.version;
  // 能回调就说明 Folio 已经有这张票，推单状态跟着落定
  const pushed = { folioPushStatus: "pushed", folioPushError: "" };
  const reddened: FolioOrderPatch = {
    invoiceStatus: "reddened",
    invoicePdfUrl: "",
    invoiceSyncVersion: version,
    ...(body.invoiceId ? { folioInvoiceId: body.invoiceId } : {}),
    ...pushed,
  };
  switch (body.event) {
    case "invoice.issued":
    case "invoice.resync": {
      const notice: FolioNoticeKind | "" =
        body.event === "invoice.issued" ? (body.previousInvoiceId ? "reissued" : "issued") : "";
      // 同步的是已红冲的票时，Folio 给的 status 是 reddened
      if (body.status === "reddened") return { applied: true, patch: reddened, noticeKind: "" };
      return {
        applied: true,
        patch: {
          invoiceStatus: "issued",
          invoiceNo: body.fphm.slice(0, 64),
          invoiceIssuedAt: body.kprq ? body.kprq.slice(0, 32) : null,
          folioInvoiceId: body.invoiceId,
          invoicePdfUrl: httpsOnly(body.pdfUrl),
          invoiceSyncVersion: version,
          ...pushed,
        },
        noticeKind: notice,
      };
    }
    case "invoice.file_ready": {
      const pdf = httpsOnly(body.pdfUrl);
      return {
        applied: true,
        patch: { invoiceSyncVersion: version, ...(pdf ? { invoicePdfUrl: pdf } : {}) },
        noticeKind: "",
      };
    }
    case "invoice.reddened":
      return { applied: true, patch: reddened, noticeKind: "reddened" };
    default:
      // 不认识的事件只留记录
      return { applied: false, patch: null, noticeKind: "" };
  }
}
