export type CardplatformConfig = {
  siteBase: string;
  apiKey: string;
};

/** 卡台 POST /gpt-direct/cdks 单次最多发 200 张，和上游 GPTDirectCDKBatchMax 对齐。 */
export const MAX_ISSUE_COUNT = 200;

export type IssuedCdk = {
  id: number;
  code: string;
  plan: string;
  codePrefix: string;
  feeAmountMinor: number;
};

export type CardplatformPlan = {
  key: string;
  name: string;
  enabled: boolean;
  sortOrder: number;
  raw: unknown;
};

export type CdkOrderRow = {
  orderId: number;
  cdkId: number;
  codePrefix: string;
  cdkStatus: string;
  orderStatus: string;
  updatedAt: string;
};

export type IssueCardPref = {
  issuer?: string;
  segmentType?: string;
  segmentKey?: string;
};

export type DirectCardSelectPref = {
  issuer: string;
  segment_type?: string;
  segment_key: string;
};

export type DirectCardRule = {
  product: string;
  count_failures?: boolean;
  light_max_uses?: number;
  pro20_max_uses?: number;
  auto_switch_on_fail?: boolean;
  max_auto_switches?: number;
  select_mode?: string;
  select_priority?: DirectCardSelectPref[];
  strict_select?: boolean;
  is_default?: boolean;
};

export type DirectCardProduct = {
  product_code: string;
  issuer: string;
  bin: string;
  label: string;
  enabled: boolean;
  suspended: boolean;
  suspend_reason?: string;
  channel_open: boolean;
  auto_open_allowed: boolean;
  usable: boolean;
};

export type CardProductInfo = {
  id?: number;
  product_code: string;
  issuer: string;
  bin: string;
  network: string;
  issuing_area: string;
  scene: string;
  card_group: string;
  enabled: boolean;
  suspended_at: string;
  description: string;
  bin_heads: string[];
};

type Envelope<T> = {
  code?: number;
  msg?: string;
  error_code?: string;
  data?: T;
};

export class CardplatformError extends Error {
  readonly httpStatus: number;
  readonly code: number;
  readonly errorCode: string;
  readonly outcomeUnknown: boolean;

  constructor(input: {
    message: string;
    httpStatus?: number;
    code?: number;
    errorCode?: string;
    outcomeUnknown?: boolean;
  }) {
    super(input.message);
    this.name = "CardplatformError";
    this.httpStatus = input.httpStatus ?? 0;
    this.code = input.code ?? 0;
    this.errorCode = input.errorCode ?? "";
    this.outcomeUnknown = input.outcomeUnknown ?? false;
  }

  get retryable() {
    return [408, 429, 502, 503, 504].includes(this.httpStatus);
  }
}

function openApiBase(siteBase: string) {
  return `${siteBase
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/openapi(?:\/v1)?$/i, "")}/openapi/v1`;
}

export function parseUsdToCents(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value * 100);
  }
  const text = String(value).trim();
  if (!/^-?\d+(\.\d{1,8})?$/.test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  const cents = Number(`${whole}${frac.padEnd(2, "0").slice(0, 2)}`);
  return Number.isFinite(cents) ? cents : null;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function parseIssued(value: unknown): IssuedCdk[] {
  const root = asObject(value);
  const list = Array.isArray(root.issued) ? root.issued : [];
  return list.map((raw) => {
    const row = asObject(raw);
    return {
      id: Number(row.id || 0),
      code: String(row.code || row.full_code || "").trim(),
      plan: String(row.plan || "").trim(),
      codePrefix: String(row.code_prefix || "").trim(),
      feeAmountMinor: Number(row.fee_amount_minor || 0),
    };
  });
}

export class CardplatformClient {
  constructor(private readonly config: CardplatformConfig) {}

  private async request<T>(
    method: string,
    path: string,
    options?: { body?: unknown; idempotencyKey?: string; timeoutMs?: number },
  ): Promise<T> {
    if (!this.config.apiKey.trim()) {
      throw new CardplatformError({
        message: "卡台 API Key 未配置",
        httpStatus: 401,
      });
    }
    let response: Response;
    try {
      response = await fetch(`${openApiBase(this.config.siteBase)}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-API-Key": this.config.apiKey.trim(),
          ...(options?.idempotencyKey
            ? { "Idempotency-Key": options.idempotencyKey }
            : {}),
        },
        body: options?.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(options?.timeoutMs ?? 45_000),
        cache: "no-store",
      });
    } catch (error) {
      throw new CardplatformError({
        message: error instanceof Error ? error.message : "卡台请求失败",
        httpStatus: 504,
        outcomeUnknown: method !== "GET",
      });
    }

    const raw = await response.text();
    let envelope: Envelope<T>;
    try {
      envelope = JSON.parse(raw) as Envelope<T>;
    } catch {
      throw new CardplatformError({
        message: htmlOrInvalidResponse(raw, response.status),
        httpStatus: response.status,
        outcomeUnknown: method !== "GET" && response.ok,
      });
    }
    if (!response.ok || envelope.code !== 0) {
      throw new CardplatformError({
        message: envelope.msg || `卡台请求失败（HTTP ${response.status}）`,
        httpStatus: response.status,
        code: Number(envelope.code || 0),
        errorCode: envelope.error_code || "",
      });
    }
    return envelope.data as T;
  }

  /**
   * 一次要 count 张，只发一个请求、只用一个幂等键。
   * 卡台可能只发出一部分（库存不够），返回的数组就会比 count 短——那是明确结果，
   * 由调用方决定要不要补发剩余，这里不重试也不报错。
   */
  async issueMany(
    plan: string,
    count: number,
    idempotencyKey: string,
    pref?: IssueCardPref,
  ): Promise<IssuedCdk[]> {
    const wanted = Math.max(1, Math.min(MAX_ISSUE_COUNT, Math.trunc(count)));
    const data = await this.request<unknown>("POST", "/gpt-direct/cdks", {
      body: {
        plan,
        count: wanted,
        funding_confirmed: true,
        ...(pref?.issuer ? { preferred_issuer: pref.issuer } : {}),
        ...(pref?.segmentType
          ? { preferred_segment_type: pref.segmentType }
          : {}),
        ...(pref?.segmentKey ? { preferred_segment_key: pref.segmentKey } : {}),
      },
      idempotencyKey,
      timeoutMs: 180_000,
    });
    const issued = parseIssued(data);
    // 有条目但卡密不全：卡台那边可能真扣了卡而我们记不下来，只能转人工。
    if (issued.some((item) => !item.code)) {
      throw new CardplatformError({
        message: "卡台未返回完整卡密",
        outcomeUnknown: true,
      });
    }
    if (issued.length === 0) {
      throw new CardplatformError({
        message: "卡台这次没有发出卡密",
        errorCode: "CARDPLATFORM_ISSUED_NONE",
      });
    }
    return issued.slice(0, wanted);
  }

  async issueOne(plan: string, idempotencyKey: string, pref?: IssueCardPref) {
    const [item] = await this.issueMany(plan, 1, idempotencyKey, pref);
    if (!item) {
      throw new CardplatformError({ message: "卡台未返回完整卡密" });
    }
    return item;
  }

  async disableCdk(id: number) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new CardplatformError({ message: "卡台卡密 ID 无效" });
    }
    await this.request<unknown>(
      "POST",
      `/gpt-direct/cdks/${id}/disable`,
      { body: {} },
    );
  }

  async deleteCdkAndRefund(id: number) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new CardplatformError({ message: "卡台卡密 ID 无效" });
    }
    await this.request<unknown>("DELETE", `/gpt-direct/cdks/${id}`);
  }

  async getBalance(timeoutMs = 45_000): Promise<{
    balanceCents: number | null;
    spendableCents: number | null;
    currency: string;
  }> {
    const data = asObject(
      await this.request<unknown>("GET", "/balance", { timeoutMs }),
    );
    return {
      balanceCents: parseUsdToCents(data.balance),
      spendableCents: parseUsdToCents(
        data.spendable_balance ?? data.balance,
      ),
      currency: String(data.currency || "USD"),
    };
  }

  async enableCdk(id: number) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new CardplatformError({ message: "卡台卡密 ID 无效" });
    }
    await this.request<unknown>("POST", `/gpt-direct/cdks/${id}/enable`, {
      body: {},
    });
  }

  async getPlans(timeoutMs = 45_000): Promise<CardplatformPlan[]> {
    const data = await this.request<unknown>("GET", "/gpt-direct/plans", {
      timeoutMs,
    });
    const root = asObject(data);
    const plans = asObject(root.plans);
    const registry = Array.isArray(root.registry)
      ? root.registry.map(asObject)
      : [];
    const registryByKey = new Map(
      registry.map((item) => [String(item.key || ""), item]),
    );
    const mapped = Object.entries(plans).map(([key, value]) => {
      const row = asObject(value);
      const meta = registryByKey.get(key);
      return {
        key,
        name: String(meta?.label || row.label || row.name || key),
        enabled: row.enabled !== false,
        sortOrder: Number(meta?.sort_order || row.sort_order || 0),
        raw: { ...row, registry: meta },
      };
    });
    return filterSellablePlans(mapped, registry.length > 0);
  }

  /** 对账用：按 updated_after 拉 CDK 兑换订单，回调不可用时同步卡密状态。 */
  async listCdkOrders(query: {
    page?: number;
    pageSize?: number;
    updatedAfter?: string;
  }): Promise<{ list: CdkOrderRow[]; total: number }> {
    const params = new URLSearchParams({
      page: String(Math.max(1, query.page ?? 1)),
      page_size: String(Math.min(100, Math.max(1, query.pageSize ?? 100))),
    });
    const updatedAfter = query.updatedAfter?.trim();
    if (updatedAfter) params.set("updated_after", updatedAfter);
    const data = asObject(
      await this.request<unknown>("GET", `/gpt-direct/cdk-orders?${params}`),
    );
    const list = Array.isArray(data.list) ? data.list : [];
    return { list: list.map(parseCdkOrderRow), total: Number(data.total || 0) };
  }

  async getDirectCardProducts(): Promise<DirectCardProduct[]> {
    const data = await this.request<unknown>("GET", "/gpt-direct/card-products");
    if (Array.isArray(data)) return data.map(parseDirectCardProduct);
    const root = asObject(data);
    const list = Array.isArray(root.list) ? root.list : [];
    return list.map(parseDirectCardProduct);
  }

  async getProducts(): Promise<CardProductInfo[]> {
    const data = await this.request<unknown>(
      "GET",
      "/products?page=1&page_size=200",
    );
    const list = Array.isArray(data)
      ? data
      : Array.isArray(asObject(data).list)
        ? (asObject(data).list as unknown[])
        : [];
    return list.map(parseCardProductInfo);
  }

  async getCardRules(product = ""): Promise<DirectCardRule[]> {
    const path = product.trim()
      ? `/gpt-direct/card-rules?product=${encodeURIComponent(product.trim())}`
      : "/gpt-direct/card-rules";
    const data = await this.request<unknown>("GET", path);
    const one = asObject(data);
    if (String(one.product || "").trim()) {
      return [parseDirectCardRule(one)];
    }
    const list = Array.isArray(asObject(data).list)
      ? (asObject(data).list as unknown[])
      : Array.isArray(data)
        ? data
        : [];
    return list.map(parseDirectCardRule);
  }

  async putCardRule(rule: DirectCardRule): Promise<DirectCardRule> {
    const data = await this.request<unknown>("PUT", "/gpt-direct/card-rules", {
      body: rule,
    });
    return parseDirectCardRule(asObject(data));
  }

  private async publicCdkRequest(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    device = "kaimi-web",
  ) {
    let response: Response;
    try {
      response = await fetch(
        `${this.config.siteBase.trim().replace(/\/+$/, "")}/api/v1/cdk${path}`,
        {
          method,
          headers: {
            Accept: "application/json",
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
            "X-Redemption-Device": device,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(45_000),
          cache: "no-store",
        },
      );
    } catch (error) {
      throw new CardplatformError({
        message: error instanceof Error ? error.message : "卡台兑换请求失败",
        httpStatus: 504,
        outcomeUnknown: method === "POST" && path === "/redeem",
      });
    }
    const raw = await response.text();
    let payload: Record<string, unknown>;
    try {
      payload = asObject(JSON.parse(raw));
    } catch {
      throw new CardplatformError({
        message: htmlOrInvalidResponse(raw, response.status),
        httpStatus: response.status,
        outcomeUnknown: method === "POST" && path === "/redeem" && response.ok,
      });
    }
    const businessCode =
      typeof payload.code === "number" || typeof payload.code === "string"
        ? Number(payload.code)
        : 0;
    const businessOk =
      !Number.isFinite(businessCode) ||
      businessCode === 0 ||
      businessCode === 1 ||
      businessCode === 200;
    return {
      status: response.status,
      ok: response.ok && businessOk && !payload.error_code,
      payload,
    };
  }

  previewCdk(code: string, device?: string) {
    return this.publicCdkRequest("POST", "/preview", { code }, device);
  }

  preflightCdk(body: Record<string, unknown>, device?: string) {
    return this.publicCdkRequest("POST", "/preflight", body, device);
  }

  redeemCdk(body: Record<string, unknown>, device?: string) {
    return this.publicCdkRequest("POST", "/redeem", body, device);
  }

  getCdkResult(token: string, device?: string) {
    return this.publicCdkRequest(
      "GET",
      `/result?token=${encodeURIComponent(token)}`,
      undefined,
      device,
    );
  }

  getCdkResultByCode(code: string, device?: string) {
    return this.publicCdkRequest(
      "GET",
      `/result-by-code?code=${encodeURIComponent(code)}`,
      undefined,
      device,
    );
  }
}

export function htmlOrInvalidResponse(raw: string, status: number) {
  const sample = raw.trim().slice(0, 80).toLowerCase();
  if (
    sample.startsWith("<") ||
    sample.includes("<!doctype html") ||
    sample.includes("<html")
  ) {
    // 这句会经 order.message 落到买家眼前，所以不放「检查 API 地址与密钥」这种运维指令。
    return `卡台返回了 HTML 而非 JSON (HTTP ${status})`;
  }
  return `卡台返回了无效响应（HTTP ${status}）`;
}

function parseCdkOrderRow(value: unknown): CdkOrderRow {
  const row = asObject(value);
  return {
    orderId: Number(row.order_id || row.id || 0),
    cdkId: Number(row.cdk_id || 0),
    codePrefix: String(row.code_prefix || "").trim(),
    cdkStatus: String(row.cdk_status || "").trim(),
    orderStatus: String(row.status || "").trim(),
    updatedAt: String(
      row.updated_at || row.completed_at || row.created_at || "",
    ).trim(),
  };
}

function parseDirectCardProduct(value: unknown): DirectCardProduct {
  const row = asObject(value);
  return {
    product_code: String(row.product_code || "").trim(),
    issuer: String(row.issuer || "").trim(),
    bin: String(row.bin || "").trim(),
    label: String(row.label || row.description || "").trim(),
    enabled: row.enabled !== false,
    suspended: Boolean(row.suspended),
    suspend_reason: String(row.suspend_reason || "").trim(),
    channel_open: row.channel_open !== false,
    auto_open_allowed: Boolean(row.auto_open_allowed),
    usable: row.usable !== false,
  };
}

function parseCardProductInfo(value: unknown): CardProductInfo {
  const row = asObject(value);
  const heads = Array.isArray(row.bin_heads)
    ? row.bin_heads.map((item) => String(item))
    : [];
  return {
    id: Number(row.id || 0) || undefined,
    product_code: String(row.product_code || "").trim(),
    issuer: String(row.issuer || "").trim(),
    bin: String(row.bin || "").trim(),
    network: String(row.network || "").trim(),
    issuing_area: String(row.issuing_area || "").trim(),
    scene: String(row.scene || "").trim(),
    card_group: String(row.card_group || "").trim(),
    enabled: row.enabled !== false,
    suspended_at: String(row.suspended_at || "").trim(),
    description: String(row.description || row.label || "").trim(),
    bin_heads: heads,
  };
}

function parseDirectCardRule(value: unknown): DirectCardRule {
  const row = asObject(value);
  const priority = Array.isArray(row.select_priority)
    ? row.select_priority.map((item) => {
        const pref = asObject(item);
        return {
          issuer: String(pref.issuer || "").trim(),
          segment_type: String(pref.segment_type || "").trim() || undefined,
          segment_key: String(pref.segment_key || "").trim(),
        };
      })
    : [];
  return {
    product: String(row.product || "").trim(),
    count_failures: row.count_failures !== false,
    light_max_uses: Number(row.light_max_uses || 0) || undefined,
    pro20_max_uses: Number(row.pro20_max_uses || 0) || undefined,
    auto_switch_on_fail: row.auto_switch_on_fail !== false,
    max_auto_switches: Number(row.max_auto_switches || 0) || undefined,
    select_mode: String(row.select_mode || "").trim() || undefined,
    select_priority: priority,
    strict_select: Boolean(row.strict_select),
    is_default: Boolean(row.is_default),
  };
}

const NON_CDK_PLAN_PREFIXES = ["claude_"];

export function isCdkSellableKey(key: string) {
  const normalized = key.trim().toLowerCase();
  if (!normalized) return false;
  return !NON_CDK_PLAN_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function filterSellablePlans(
  plans: CardplatformPlan[],
  hasRegistry: boolean,
): CardplatformPlan[] {
  const sellable = hasRegistry
    ? plans.filter((plan) => {
        const raw = asObject(plan.raw);
        return plan.enabled && Boolean(raw.registry);
      })
    : plans.filter((plan) => plan.enabled && isCdkSellableKey(plan.key));
  return sellable.sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.key.localeCompare(b.key);
  });
}
