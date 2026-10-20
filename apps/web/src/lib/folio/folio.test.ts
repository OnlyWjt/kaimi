import { rmSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// 真库：验签的 nonce、回调去重、代理通知、推单都要落库才看得出对不对。
const DB_FILE = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { rmSync: rm } = require("node:fs") as typeof import("node:fs");
  const file = join(tmpdir(), "kaimi-folio-test.db").replace(/\\/g, "/");
  for (const suffix of ["", "-wal", "-shm"]) rm(`${file}${suffix}`, { force: true });
  process.env.KAIMI_DATABASE_URL = `file:${file}`;
  return file;
});

const dispatchNotifyText = vi.hoisted(() => vi.fn());

vi.mock("@/lib/sync-scheduler", () => ({ ensureSyncScheduler: () => undefined }));
vi.mock("@/lib/notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify")>()),
  dispatchNotifyText,
}));

const SECRET = "folio-test-secret-0123456789abcdef";
const AT = String.fromCharCode(64);

type M = {
  db: typeof import("@/db").db;
  schema: typeof import("@/db/schema");
  orm: typeof import("drizzle-orm");
  config: typeof import("@/lib/config");
  crypto: typeof import("@/lib/crypto");
  core: typeof import("./core");
  sign: typeof import("./sign");
  callback: typeof import("./callback");
  notice: typeof import("./agent-notice");
  push: typeof import("./push");
  jobs: typeof import("@/lib/background-jobs");
};
let m: M;
let seq = 0;

beforeAll(async () => {
  const config = await import("@/lib/config");
  await config.bootDb();
  m = {
    db: (await import("@/db")).db,
    schema: await import("@/db/schema"),
    orm: await import("drizzle-orm"),
    config,
    crypto: await import("@/lib/crypto"),
    core: await import("./core"),
    sign: await import("./sign"),
    callback: await import("./callback"),
    notice: await import("./agent-notice"),
    push: await import("./push"),
    jobs: await import("@/lib/background-jobs"),
  };
  await config.setSetting("folio_base_url", "https://folio.test");
  await config.setSetting("folio_secret", m.crypto.encryptSecret(SECRET));
});

beforeEach(async () => {
  await m.config.setSetting("folio_enabled", "1");
  dispatchNotifyText.mockReset();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  (await import("@/db")).client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${DB_FILE}${suffix}`, { force: true });
    } catch {
      /* Windows 句柄未释放时留着，下次运行开头会删 */
    }
  }
});

async function makeAgent(values: { telegramChatId?: string; telegramNotifyEnabled?: boolean; invoiceNotifyEnabled?: boolean } = {}) {
  seq += 1;
  const [agent] = await m.db
    .insert(m.schema.agents)
    .values({ displayName: `店${seq}`, currentSlug: `folio-shop-${seq}`, ...values })
    .returning();
  return agent;
}

async function makeOrder(agentId: number, values: Partial<typeof import("@/db/schema").storeOrders.$inferInsert> = {}) {
  seq += 1;
  const now = new Date().toISOString();
  const [order] = await m.db
    .insert(m.schema.storeOrders)
    .values({
      orderNo: `KSFOLIO${seq}`,
      queryTokenHash: `folio-qt-${seq}`,
      agentId,
      planId: 1,
      planKeySnapshot: "chatgpt_plus_month",
      productNameSnapshot: "ChatGPT Plus 月卡",
      retailPriceCents: 10000,
      agentCostCents: 8000,
      grossCents: 11000,
      invoiceRequested: true,
      invoiceTitle: "上海某某科技有限公司",
      invoiceTaxNo: "91310000MA1FL2XW3R",
      invoiceNote: "备注",
      invoiceEmail: `abcdef${AT}qq.com`,
      invoiceAmountCents: 11000,
      invoiceSurchargeCents: 1000,
      paymentChannel: "alipay",
      feeRatePpm: 6000,
      fixedFeeCents: 0,
      estimatedPaymentFeeCents: 66,
      finalPaymentFeeCents: 66,
      agentEarningCents: 1940,
      fulfillmentIdempotencyKey: `folio-fk-${seq}`,
      customerEmail: `buyer${AT}example.com`,
      payStatus: "paid",
      fulfillStatus: "delivered",
      paidAt: now,
      createdAt: now,
      updatedAt: now,
      ...values,
    })
    .returning();
  return order;
}

function signedRequest(method: "GET" | "POST", path: string, body = "", overrides: { nonce?: string; ts?: string } = {}) {
  const ts = overrides.ts ?? String(Math.floor(Date.now() / 1000));
  const nonce = overrides.nonce ?? `n${Math.random().toString(16).slice(2)}${seq}`;
  return new Request(`http://localhost:3100${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Folio-Timestamp": ts,
      "X-Folio-Nonce": nonce,
      "X-Folio-Signature": m.core.folioSign(method, path, ts, nonce, body, SECRET),
    },
    body: method === "POST" ? body : undefined,
  });
}

function callbackBody(orderNo: string, overrides: Record<string, unknown> = {}) {
  return {
    event_id: `inv:57:v1:${orderNo}`,
    event: "invoice.issued",
    version: 1,
    order_no: orderNo,
    invoice_id: "57",
    previous_invoice_id: "",
    status: "issued",
    fphm: "26312000000000012345",
    kprq: "2026-10-20 14:03:11",
    amount: "110.00",
    email_status: "sent",
    pdf_url: "https://folio.test/57.pdf",
    red_reason_code: "",
    error_message: "",
    ...overrides,
  };
}

describe("验签", () => {
  const path = "/api/v1/integrations/folio/orders/KS1";

  it("签名对通过；同一个 nonce 再来一次按重放拒绝", async () => {
    const req = signedRequest("GET", path, "", { nonce: "replay-nonce-001" });
    expect(await m.sign.verifyFolioRequest(req, "")).toEqual({ ok: true });
    const again = signedRequest("GET", path, "", { nonce: "replay-nonce-001" });
    expect(await m.sign.verifyFolioRequest(again, "")).toMatchObject({ ok: false, status: 401 });
  });

  it("时间戳超窗、签名不对拒绝", async () => {
    const old = signedRequest("GET", path, "", { ts: String(Math.floor(Date.now() / 1000) - 400) });
    expect(await m.sign.verifyFolioRequest(old, "")).toMatchObject({ ok: false, status: 401 });
    const tampered = signedRequest("POST", path, '{"a":1}');
    expect(await m.sign.verifyFolioRequest(tampered, '{"a":2}')).toMatchObject({ ok: false, status: 401 });
  });

  it("开关关着返回 503", async () => {
    await m.config.setSetting("folio_enabled", "0");
    expect(await m.sign.verifyFolioRequest(signedRequest("GET", path), "")).toMatchObject({ ok: false, status: 503 });
  });

  it("过期 nonce 会被清掉", async () => {
    await m.db.insert(m.schema.folioNonces).values({ nonce: "expired-nonce-1", expiresAt: "2000-01-01T00:00:00.000Z" });
    expect(await m.sign.pruneFolioNonces()).toBeGreaterThanOrEqual(1);
  });
});

describe("B 查单接口", () => {
  it("签名通过返回开票金额 = 实付", async () => {
    const { GET } = await import("@/app/api/v1/integrations/folio/orders/[orderNo]/route");
    const agent = await makeAgent();
    const order = await makeOrder(agent.id);
    const path = `/api/v1/integrations/folio/orders/${order.orderNo}`;
    const response = await GET(signedRequest("GET", path), { params: Promise.resolve({ orderNo: order.orderNo }) });
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.status_code).toBe(0);
    expect(data.data).toMatchObject({ order_no: order.orderNo, invoiceable: "110.00", invoiceable_state: "ok", consistent: true });

    const missing = await GET(signedRequest("GET", "/api/v1/integrations/folio/orders/KSNONE"), {
      params: Promise.resolve({ orderNo: "KSNONE" }),
    });
    expect(await missing.json()).toEqual({ status_code: 404, msg: "订单不存在" });
  });
});

describe("C 回调", () => {
  it("回写订单、记事件、入队代理通知；同一 event_id 只处理一次", async () => {
    const { POST } = await import("@/app/api/v1/integrations/folio/callback/route");
    const agent = await makeAgent();
    const order = await makeOrder(agent.id, { folioPushStatus: "pushed" });
    const raw = JSON.stringify(callbackBody(order.orderNo));
    const path = m.core.FOLIO_CALLBACK_PATH;

    const first = await POST(signedRequest("POST", path, raw));
    expect(await first.json()).toMatchObject({ status_code: 0, data: { accepted: true } });
    const second = await POST(signedRequest("POST", path, raw));
    expect(await second.json()).toMatchObject({ status_code: 0, data: { duplicate: true } });

    const after = await m.db.query.storeOrders.findFirst({ where: m.orm.eq(m.schema.storeOrders.id, order.id) });
    expect(after).toMatchObject({
      invoiceStatus: "issued",
      invoiceNo: "26312000000000012345",
      invoiceIssuedAt: "2026-10-20 14:03:11",
      folioInvoiceId: "57",
      invoicePdfUrl: "https://folio.test/57.pdf",
      invoiceSyncVersion: 1,
    });
    const events = await m.db.query.folioInvoiceEvents.findMany({
      where: m.orm.eq(m.schema.folioInvoiceEvents.orderId, order.id),
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ applied: true, noticeKind: "issued", agentNotifyStatus: "pending" });
    const jobs = await m.db.query.backgroundJobs.findMany({
      where: m.orm.eq(m.schema.backgroundJobs.dedupeKey, `notify_agent_invoice:${events[0].id}`),
    });
    expect(jobs).toHaveLength(1);
  });

  it("订单不存在回 404；验签不过回 401", async () => {
    const { POST } = await import("@/app/api/v1/integrations/folio/callback/route");
    const raw = JSON.stringify(callbackBody("KSNONE"));
    expect((await POST(signedRequest("POST", m.core.FOLIO_CALLBACK_PATH, raw))).status).toBe(404);
    const bad = signedRequest("POST", "/elsewhere", raw);
    const forged = new Request(`http://localhost:3100${m.core.FOLIO_CALLBACK_PATH}`, {
      method: "POST",
      headers: bad.headers,
      body: raw,
    });
    expect((await POST(forged)).status).toBe(401);
  });

  it("低版本只记录、不回写、不通知", async () => {
    const agent = await makeAgent();
    const order = await makeOrder(agent.id, { invoiceStatus: "reddened", invoiceSyncVersion: 3 });
    const body = m.core.parseFolioCallback(callbackBody(order.orderNo, { event_id: `old:${order.orderNo}`, version: 2 }))!;
    const result = await m.callback.applyFolioCallback(body, "{}");
    expect(result).toMatchObject({ kind: "accepted", applied: false, noticeKind: "" });
    const after = await m.db.query.storeOrders.findFirst({ where: m.orm.eq(m.schema.storeOrders.id, order.id) });
    expect(after?.invoiceStatus).toBe("reddened");
  });
});

async function pendingEvent(orderId: number, kind = "issued") {
  seq += 1;
  const [row] = await m.db
    .insert(m.schema.folioInvoiceEvents)
    .values({
      orderId,
      eventId: `evt-${seq}`,
      event: kind === "reddened" ? "invoice.reddened" : "invoice.issued",
      version: 1,
      kprq: "2026-10-20 14:03:11",
      redReasonCode: kind === "reddened" ? "02" : "",
      applied: true,
      noticeKind: kind,
      agentNotifyStatus: "pending",
      payloadJson: JSON.stringify({ email_status: "sent" }),
    })
    .returning();
  return row;
}

describe("代理开票通知", () => {
  const sentOk = { text: "", webhook: { attempted: false, ok: false, error: "" }, telegram: { attempted: true, ok: true, error: "" } };

  it("没绑定、关了 Telegram 通知、关了开票通知都记 skipped，不发", async () => {
    for (const values of [
      {},
      { telegramChatId: `${700100 + seq}`, telegramNotifyEnabled: false },
      { telegramChatId: `${700200 + seq}`, invoiceNotifyEnabled: false },
    ]) {
      const agent = await makeAgent(values);
      const order = await makeOrder(agent.id);
      const event = await pendingEvent(order.id);
      expect((await m.notice.deliverAgentInvoiceNotice(event.id)).status).toBe("skipped");
    }
    expect(dispatchNotifyText).not.toHaveBeenCalled();
  });

  it("绑定了就发到代理自己的 chat，成功记 sent", async () => {
    dispatchNotifyText.mockResolvedValue(sentOk);
    const agent = await makeAgent({ telegramChatId: "880001" });
    const order = await makeOrder(agent.id);
    const event = await pendingEvent(order.id);
    expect(await m.notice.deliverAgentInvoiceNotice(event.id)).toEqual({ status: "sent", error: "" });
    const [text, , eventName, overrides] = dispatchNotifyText.mock.calls[0];
    expect(text).toContain("🧾 发票已开具");
    expect(text).toContain(`ab***${AT}qq.com`);
    expect(eventName).toBe("invoice.agent");
    expect(overrides).toEqual({ telegramChatId: "880001", webhookUrl: "" });
    // 已发过的不再重复发
    expect((await m.notice.deliverAgentInvoiceNotice(event.id)).status).toBe("");
  });

  it("Telegram 失败记 failed、计一次并抛错交给重试", async () => {
    dispatchNotifyText.mockResolvedValue({ ...sentOk, telegram: { attempted: true, ok: false, error: "boom" } });
    const agent = await makeAgent({ telegramChatId: "880002" });
    const order = await makeOrder(agent.id);
    const event = await pendingEvent(order.id);
    await expect(m.notice.deliverAgentInvoiceNotice(event.id)).rejects.toThrow("boom");
    const row = await m.db.query.folioInvoiceEvents.findFirst({ where: m.orm.eq(m.schema.folioInvoiceEvents.id, event.id) });
    expect(row).toMatchObject({ agentNotifyStatus: "failed", agentNotifyAttempts: 1, agentNotifyError: "boom" });
  });

  it("已退款订单上的红冲通知也会由后台任务发出", async () => {
    dispatchNotifyText.mockResolvedValue(sentOk);
    const agent = await makeAgent({ telegramChatId: "880003" });
    const order = await makeOrder(agent.id, { payStatus: "refunded", fulfillStatus: "refunded" });
    const event = await pendingEvent(order.id, "reddened");
    const now = new Date().toISOString();
    await m.db.insert(m.schema.backgroundJobs).values({
      type: "notify_agent_invoice",
      dedupeKey: `notify_agent_invoice:${event.id}`,
      payloadJson: JSON.stringify({ eventId: event.id }),
      runAfter: now,
      createdAt: now,
      updatedAt: now,
    });
    await m.jobs.processBackgroundJobs(50);
    const row = await m.db.query.folioInvoiceEvents.findFirst({ where: m.orm.eq(m.schema.folioInvoiceEvents.id, event.id) });
    expect(row?.agentNotifyStatus).toBe("sent");
    expect(dispatchNotifyText.mock.calls.at(-1)?.[0]).toContain("原因：销货退回");
  });
});

describe("推单", () => {
  function stubFolio(status: number, body: unknown) {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("成功记 pushed，带签名头和开票金额", async () => {
    const fetchMock = stubFolio(200, { status_code: 0, data: { invoice_id: 99, status: "pending_review", duplicate: false } });
    const agent = await makeAgent();
    const order = await makeOrder(agent.id, { folioPushStatus: "pending" });
    await m.push.pushOrderToFolio(order.id);
    const after = await m.db.query.storeOrders.findFirst({ where: m.orm.eq(m.schema.storeOrders.id, order.id) });
    expect(after).toMatchObject({ folioPushStatus: "pushed", folioInvoiceId: "99", invoiceStatus: "pending_review" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://folio.test/api/integration/v1/invoice-requests");
    expect(JSON.parse(init.body)).toMatchObject({ order_no: order.orderNo, invoice_amount: "110.00" });
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Folio-Signature"]).toBe(
      m.core.folioSign("POST", m.core.FOLIO_PUSH_PATH, headers["X-Folio-Timestamp"], headers["X-Folio-Nonce"], init.body, SECRET),
    );
  });

  it("422 记 rejected，不抛错", async () => {
    stubFolio(422, { status_code: 422, msg: "推送金额与实付不一致" });
    const agent = await makeAgent();
    const order = await makeOrder(agent.id, { folioPushStatus: "pending" });
    await m.push.pushOrderToFolio(order.id);
    const after = await m.db.query.storeOrders.findFirst({ where: m.orm.eq(m.schema.storeOrders.id, order.id) });
    expect(after?.folioPushStatus).toBe("rejected");
    expect(after?.folioPushError).toContain("推送金额与实付不一致");
  });

  it("503 抛错交给重试，重试用尽标 failed，之后可以补推", async () => {
    stubFolio(503, { status_code: 503, msg: "查询订单失败" });
    const agent = await makeAgent();
    const order = await makeOrder(agent.id, { folioPushStatus: "pending" });
    await expect(m.push.pushOrderToFolio(order.id)).rejects.toThrow("503");
    await m.push.markFolioPushExhausted(order.id, "Folio HTTP 503");
    const after = await m.db.query.storeOrders.findFirst({ where: m.orm.eq(m.schema.storeOrders.id, order.id) });
    expect(after?.folioPushStatus).toBe("failed");
    expect(await m.push.enqueueFolioPush(order.id)).toBe(true);
    expect(await m.push.enqueueFolioPush(order.id)).toBe(false);
  });

  it("开关关着不推，清掉排队状态", async () => {
    await m.config.setSetting("folio_enabled", "0");
    const fetchMock = stubFolio(200, {});
    const agent = await makeAgent();
    const order = await makeOrder(agent.id, { folioPushStatus: "pending" });
    await m.push.pushOrderToFolio(order.id);
    expect(fetchMock).not.toHaveBeenCalled();
    const after = await m.db.query.storeOrders.findFirst({ where: m.orm.eq(m.schema.storeOrders.id, order.id) });
    expect(after?.folioPushStatus).toBe("");
  });

  it("退款推送记下 Folio 的处理结果；被拒绝过的单不推", async () => {
    stubFolio(200, { status_code: 0, data: { action: "red_flush", invoice_id: 99 } });
    const agent = await makeAgent();
    const order = await makeOrder(agent.id, { folioPushStatus: "pushed", payStatus: "refunded", fulfillStatus: "refunded" });
    expect(await m.push.enqueueFolioRefund(order.id)).toBe(true);
    await m.push.pushRefundToFolio(order.id);
    const after = await m.db.query.storeOrders.findFirst({ where: m.orm.eq(m.schema.storeOrders.id, order.id) });
    expect(after?.folioRefundAction).toBe("red_flush");
    const rejected = await makeOrder(agent.id, { folioPushStatus: "rejected", payStatus: "refunded" });
    expect(await m.push.enqueueFolioRefund(rejected.id)).toBe(false);
  });
});
