import ExcelJS from "exceljs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeAgentSlug, validateAgentSlug } from "./agent-slug";
import {
  calculateAgentEarningCents,
  calculatePaymentFeeCents,
} from "./payments/fees";
import {
  moneyYuan,
  parseMoneyYuan,
  queryEpayOrder,
  signEpayParams,
  verifyEpayNotify,
} from "./payments/epay";
import { buildEarningsWorkbook } from "./earnings-export";
import { periodBoundary } from "./period";
import {
  epayParamsFromSearch,
  looksLikeStoreQueryToken,
  pickStoreQueryToken,
} from "./store-order-access";
import {
  CardplatformClient,
  filterSellablePlans,
  htmlOrInvalidResponse,
  parseUsdToCents,
} from "./cardplatform/client";
import { evaluateCardFailVerdict } from "./cardplatform/health-logic";
import { canonicalCardIssuer } from "./cardplatform/issuer";
import {
  applyRedeemCardPolicy,
  buildSelectPriority,
  defaultSiteRedeemPolicy,
} from "./cardplatform/policy-logic";
import { mapCardplatformStatus } from "./cardplatform/status";
import {
  normalizeAccountWebhookPath,
} from "./cardplatform/urls";
import {
  webhookSignatureMatches,
} from "./cardplatform/webhook-verify";
import { createHmac } from "node:crypto";
import { decryptSecret, encryptSecret } from "./crypto";
import { sanitizeLog } from "./log";
import { messageFromApiBody } from "./http-error";
import { centsFromYuanText, yuanTextFromCents } from "./money";
import { isIpv4, isIpv6 } from "./network/egress";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("agent slug", () => {
  it("normalizes and accepts a valid slug", () => {
    expect(normalizeAgentSlug("  Agent-1001 ")).toBe("agent-1001");
    expect(validateAgentSlug("Agent-1001")).toEqual({
      ok: true,
      slug: "agent-1001",
    });
  });

  it("rejects reserved and ambiguous slugs", () => {
    expect(validateAgentSlug("admin").ok).toBe(false);
    expect(validateAgentSlug("bad--slug").ok).toBe(false);
    expect(validateAgentSlug("-bad").ok).toBe(false);
  });
});

describe("money drafts", () => {
  it("lets users type yuan text without snapping to two decimals", () => {
    expect(yuanTextFromCents(107)).toBe("1.07");
    expect(centsFromYuanText("1")).toBe(100);
    expect(centsFromYuanText("1.")).toBe(100);
    expect(centsFromYuanText("1.0")).toBe(100);
    expect(centsFromYuanText("1.07")).toBe(107);
    expect(centsFromYuanText("")).toBeNull();
    expect(centsFromYuanText("abc")).toBeNaN();
  });
});

describe("payment fees", () => {
  it("uses integer cents and ppm rounding", () => {
    const fee = calculatePaymentFeeCents(108_000, {
      ratePpm: 6_000,
      fixedFeeCents: 0,
    });
    expect(fee).toBe(648);
    expect(calculateAgentEarningCents(108_000, 103_000, fee)).toBe(4_352);
  });

  it("formats and parses money without floating-point arithmetic", () => {
    expect(moneyYuan(108_001)).toBe("1080.01");
    expect(parseMoneyYuan("1080.01")).toBe(108_001);
    expect(() => parseMoneyYuan("1.001")).toThrow("invalid money");
  });
});

describe("epay signing", () => {
  it("sorts parameters and excludes signature fields", () => {
    expect(
      signEpayParams(
        { c: "d", a: "b", sign: "ignored", sign_type: "MD5", empty: "" },
        "test-key",
      ),
    ).toBe("5f98545a938c23acbdce32ebebf69440");
  });

  it("verifies a successful notification", () => {
    const params = {
      pid: "1001",
      money: "1.00",
      trade_status: "TRADE_SUCCESS",
      sign: "",
    };
    params.sign = signEpayParams(params, "test-key");
    expect(
      verifyEpayNotify(
        { apiBase: "https://pay.invalid", pid: "1001", key: "test-key" },
        params,
      ),
    ).toEqual({ ok: true });
  });
});

describe("store order access", () => {
  it("accepts kaimi query tokens and ignores payment gateway tokens", () => {
    expect(looksLikeStoreQueryToken("abcdefghijklmnopqrstuvwx")).toBe(true);
    expect(looksLikeStoreQueryToken("eyJhbGciOiJIUzI1NiJ9.abc")).toBe(false);
    expect(looksLikeStoreQueryToken("short")).toBe(false);
    const search = new URLSearchParams(
      "token=not-a-kaimi-token&qt=abcdefghijklmnopqrstuvwx&out_trade_no=KS1&sign=abc",
    );
    expect(pickStoreQueryToken(search)).toBe("abcdefghijklmnopqrstuvwx");
    expect(epayParamsFromSearch(search)).toEqual({
      out_trade_no: "KS1",
      sign: "abc",
    });
  });
});

describe("ops helpers", () => {
  it("parses card-platform USD balances into cents", () => {
    expect(parseUsdToCents(108.5)).toBe(10850);
    expect(parseUsdToCents("108.50")).toBe(10850);
    expect(parseUsdToCents("")).toBeNull();
  });

  it("redacts secrets and card codes from logs", () => {
    expect(sanitizeLog("ak_live_abc123 and GPTD-TEST-COMPLETE-CODE")).toBe(
      "[redacted] and [card-redacted]",
    );
  });
});

describe("period boundary", () => {
  it("expands date-only values to inclusive ISO bounds", () => {
    expect(periodBoundary("2026-09-02", false)).toBe("2026-09-02T00:00:00.000Z");
    expect(periodBoundary("2026-09-02", true)).toBe("2026-09-02T23:59:59.999Z");
  });
});

describe("earnings workbook", () => {
  it("creates ledger sheets and neutralizes formula-like text", async () => {
    const buffer = await buildEarningsWorkbook({
      summary: {
        periodStart: "2026-09-01",
        periodEnd: "2026-09-30",
        agentName: "代理 A",
        orderCount: 1,
        grossCents: 108_000,
        costCents: 103_000,
        estimatedFeeCents: 648,
        actualFeeCents: 648,
        feeDifferenceCents: 0,
        earningCents: 4_352,
        pendingCents: 4_352,
        settledCents: 0,
        reversedCents: 0,
      },
      details: [
        {
          confirmedAt: "2026-09-02 14:00:00",
          orderNo: "=1+1",
          agentName: "代理 A",
          planName: "Plus",
          paymentChannel: "alipay",
          grossCents: 108_000,
          costCents: 103_000,
          estimatedFeeCents: 648,
          actualFeeCents: 648,
          feeReconcileStatus: "confirmed",
          finalFeeCents: 648,
          earningCents: 4_352,
          earningStatus: "pending",
          settlementNo: "",
          cdkStatus: "unused",
        },
      ],
      settlements: [],
      adjustments: [
        {
          createdAt: "2026-09-02",
          orderNo: "KS-REFUND",
          agentName: "代理 A",
          type: "refund",
          amountCents: -4_352,
          reason: "=danger",
          reference: "RF-1",
          status: "pending",
          settlementNo: "",
        },
      ],
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "收益汇总",
      "收益明细",
      "账务调整",
      "结算记录",
    ]);
    expect(workbook.getWorksheet("收益明细")?.getCell("B2").value).toBe(
      "'=1+1",
    );
    expect(workbook.getWorksheet("收益明细")?.getCell("F2").value).toBe(1080);
    expect(workbook.getWorksheet("账务调整")?.getCell("F2").value).toBe(
      "'=danger",
    );
  });
});

describe("external adapters", () => {
  it("sends a fixed idempotency key when issuing one card", async () => {
    const fetchMock = vi.fn(
      async (...args: Parameters<typeof fetch>) => {
        void args;
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              requested: 1,
              issued: [
                {
                  id: 88,
                  code: "GPTD-TEST-COMPLETE-CODE",
                  plan: "plus",
                  code_prefix: "GPTD-TEST",
                  fee_amount_minor: 100,
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new CardplatformClient({
      siteBase: "https://card.invalid",
      apiKey: "test-key",
    });
    const result = await client.issueOne("plus", "kaimi-order-1", {
      issuer: "one",
      segmentType: "product",
      segmentKey: "P53780X",
    });
    expect(result.code).toBe("GPTD-TEST-COMPLETE-CODE");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe(
      "kaimi-order-1",
    );
    expect(JSON.parse(String(init.body))).toMatchObject({
      preferred_issuer: "one",
      preferred_segment_type: "product",
      preferred_segment_key: "P53780X",
    });
  });

  it("reads spendable balance from the card platform", async () => {
    const fetchMock = vi.fn(
      async (...args: Parameters<typeof fetch>) => {
        void args;
        return new Response(
          JSON.stringify({
            code: 0,
            data: { balance: 128.5, spendable_balance: 108.5, currency: "USD" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new CardplatformClient({
      siteBase: "https://card.invalid",
      apiKey: "test-key",
    });
    const result = await client.getBalance();
    expect(result.spendableCents).toBe(10850);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://card.invalid/openapi/v1/balance",
    );
  });

  it("requests upstream refund when deleting an unused card", async () => {
    const fetchMock = vi.fn(
      async (...args: Parameters<typeof fetch>) => {
        void args;
        return new Response(JSON.stringify({ code: 0 }), { status: 200 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new CardplatformClient({
      siteBase: "https://card.invalid",
      apiKey: "test-key",
    });
    await client.deleteCdkAndRefund(88);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://card.invalid/openapi/v1/gpt-direct/cdks/88",
    );
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe("DELETE");
  });

  it("marks gateways without a per-order fee field as unsupported", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            code: 1,
            status: 1,
            trade_no: "T1",
            out_trade_no: "KS1",
            type: "alipay",
            money: "1080.00",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const result = await queryEpayOrder(
      {
        apiBase: "https://pay.invalid",
        pid: "1001",
        key: "test-key",
      },
      { outTradeNo: "KS1" },
    );
    expect(result.paid).toBe(true);
    expect(result.feeSupported).toBe(false);
    expect(result.actualFeeCents).toBeNull();
  });

  it("calls the card platform public redemption API directly", async () => {
    const fetchMock = vi.fn(
      async (...args: Parameters<typeof fetch>) => {
        void args;
        return new Response(
          JSON.stringify({
            redemption_token: "rt_test",
            status: "ready",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new CardplatformClient({
      siteBase: "https://card.invalid",
      apiKey: "not-used-by-public-api",
    });
    const result = await client.previewCdk("GPTD-TEST");
    expect(result.ok).toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://card.invalid/api/v1/cdk/preview",
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("X-Redemption-Device")).toBe(
      "kaimi-web",
    );
  });

  it("keeps only sellable card-platform plans", () => {
    const filtered = filterSellablePlans(
      [
        {
          key: "plus",
          name: "Plus",
          enabled: true,
          sortOrder: 1,
          raw: { registry: { key: "plus" } },
        },
        {
          key: "claude_pro",
          name: "Claude",
          enabled: true,
          sortOrder: 2,
          raw: {},
        },
        {
          key: "disabled_plan",
          name: "Off",
          enabled: false,
          sortOrder: 3,
          raw: { registry: { key: "disabled_plan" } },
        },
      ],
      true,
    );
    expect(filtered.map((plan) => plan.key)).toEqual(["plus"]);
    expect(
      filterSellablePlans(
        [
          { key: "plus", name: "Plus", enabled: true, sortOrder: 0, raw: {} },
          {
            key: "claude_pro",
            name: "Claude",
            enabled: true,
            sortOrder: 0,
            raw: {},
          },
        ],
        false,
      ).map((plan) => plan.key),
    ).toEqual(["plus"]);
  });

  it("maps card-platform redeem statuses", () => {
    expect(mapCardplatformStatus({ status: "completed" }, true)).toBe("success");
    expect(mapCardplatformStatus({ status: "processing" }, true)).toBe(
      "processing",
    );
    expect(mapCardplatformStatus({ status: "failed" }, true)).toBe("failed");
  });

  it("explains HTML-not-JSON card-platform errors", () => {
    expect(htmlOrInvalidResponse("<html>login</html>", 200)).toContain(
      "HTML 而非 JSON",
    );
  });
});

describe("card-platform ops", () => {
  it("normalizes webhook paths under /api/v1/webhooks/cardplatform/", () => {
    expect(
      normalizeAccountWebhookPath(
        "https://cdk.example/api/v1/webhooks/cardplatform/1",
      ),
    ).toBe("/api/v1/webhooks/cardplatform/1");
    expect(() =>
      normalizeAccountWebhookPath("https://cdk.example/api/webhooks/epay"),
    ).toThrow(/cardplatform/);
  });

  it("accepts both HMAC(body) and HMAC(ts.body) webhook signatures", () => {
    const secret = "whsec_test";
    const raw = Buffer.from('{"event":"gpt_direct.completed"}', "utf8");
    const bodySig = createHmac("sha256", secret).update(raw).digest("hex");
    expect(
      webhookSignatureMatches(secret, raw, [], [bodySig]),
    ).toBe(true);
    const tsSig = createHmac("sha256", secret)
      .update(Buffer.concat([Buffer.from("1710000000."), raw]))
      .digest("hex");
    expect(
      webhookSignatureMatches(secret, raw, ["1710000000"], [`sha256=${tsSig}`]),
    ).toBe(true);
  });

  it("attributes card failures vs mailbox failures", () => {
    expect(evaluateCardFailVerdict(1, 1, 2, true)).toBe("need_more");
    expect(evaluateCardFailVerdict(2, 2, 2, true)).toBe("card_suspect");
    expect(evaluateCardFailVerdict(2, 1, 2, true)).toBe("email_suspect");
    expect(evaluateCardFailVerdict(2, 0, 2, true)).toBe("unknown_emails");
  });

  it("injects redeem policy flags and exclude_card_ids", () => {
    const policy = defaultSiteRedeemPolicy();
    policy.enabled = true;
    const body = applyRedeemCardPolicy({}, policy, true, [11, 22]);
    expect(body).toEqual({
      no_auto_card_switch: true,
      strict_card_preference: true,
      exclude_card_ids: [11, 22],
    });
    expect(canonicalCardIssuer("ch1")).toBe("one");
    expect(
      buildSelectPriority(
        [{ planKey: "P53780X", displayName: "x", binPrefix: "", channel: "ch1", enabled: true }],
        [{ productCode: "P53780X", issuer: "one", enabled: true, suspendedAt: "" }],
      ),
    ).toEqual([
      { issuer: "one", segment_type: "product", segment_key: "P53780X" },
    ]);
  });
});

describe("admin api errors", () => {
  it("reads string, nested connect, and zod flatten errors", () => {
    expect(messageFromApiBody({ error: "当前 IP 不在白名单内" })).toBe(
      "当前 IP 不在白名单内",
    );
    expect(
      messageFromApiBody({
        connect: { message: "主机可达；当前 IP 不在卡台白名单（403）" },
      }),
    ).toBe("主机可达；当前 IP 不在卡台白名单（403）");
    expect(
      messageFromApiBody({
        error: { fieldErrors: { siteBase: ["Invalid url"] }, formErrors: [] },
      }),
    ).toBe("siteBase: Invalid url");
    expect(messageFromApiBody({})).toBe("请求失败");
    expect(messageFromApiBody({}, "请求失败（HTTP 502）")).toBe(
      "请求失败（HTTP 502）",
    );
  });

  it("recognizes ipv4 vs ipv6 for whitelist copy", () => {
    expect(isIpv4("114.86.119.117")).toBe(true);
    expect(isIpv6("240e:b8f:1dbf:a000:504:391b:7142:86fe")).toBe(true);
    expect(isIpv4("240e:b8f:1dbf:a000:504:391b:7142:86fe")).toBe(false);
  });
});

describe("secret storage", () => {
  it("round-trips versioned authenticated ciphertext", () => {
    const encrypted = encryptSecret("sensitive-value");
    expect(encrypted.startsWith("enc:v2:")).toBe(true);
    expect(decryptSecret(encrypted)).toBe("sensitive-value");
  });
});
