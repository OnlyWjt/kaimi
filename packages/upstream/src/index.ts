/** Upstream Agent API types — aligned with danew_card_cdk agent-openapi. */

export type ItemStatus =
  | "pending"
  | "issuing"
  | "preparing"
  | "submitted"
  | "processing"
  | "success"
  | "failed"
  | "skipped"
  | "unknown";

export type CredMode = "session" | "mailbox";

export type AgentCredential = {
  mode: CredMode;
  session?: string;
  email?: string;
  password?: string;
  email_password?: string;
  gpt_password?: string;
};

export type AgentPlan = {
  key: string;
  name?: string;
  label?: string;
  price?: number;
  price_cny_cents?: number;
  price_yuan?: string;
  currency?: string;
  description?: string;
  is_credit?: boolean;
  [key: string]: unknown;
};

export type AgentCdk = {
  code: string;
  plan?: string;
  status?: string;
  assigned_at?: string;
  used_at?: string | null;
  [key: string]: unknown;
};

export type AgentOrder = {
  order_no: string;
  plan?: string;
  count?: number;
  amount?: number;
  status?: string;
  pay_url?: string;
  created_at?: string;
  expired_at?: string;
  [key: string]: unknown;
};

export type RechargeRecord = {
  request_id: string;
  batch_id?: string;
  plan?: string;
  status?: ItemStatus;
  message?: string;
  client_reference?: string;
  account_email?: string;
  cdk_prefix?: string;
  created_at?: string;
  updated_at?: string;
  upstream_order_id?: string;
  [key: string]: unknown;
};

export type WebhookEvent = {
  event_id: string;
  event_type: string;
  created_at?: string;
  data?: Record<string, unknown>;
};

export type UpstreamErrorBody = {
  error?: string;
  error_code?: string;
};

export class UpstreamError extends Error {
  readonly status: number;
  readonly errorCode?: string;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const parsed = body as UpstreamErrorBody;
    super(parsed?.error || `Upstream HTTP ${status}`);
    this.name = "UpstreamError";
    this.status = status;
    this.errorCode = parsed?.error_code;
    this.body = body;
  }

  get retryable() {
    return this.status === 429 || this.status === 502;
  }
}

export type UpstreamClientOptions = {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
};

function joinUrl(base: string, path: string) {
  const b = base.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  // Accept either https://host or https://host/api/v1
  if (/\/api\/v1$/i.test(b)) return `${b}${p}`;
  return `${b}/api/v1${p}`;
}

export class UpstreamClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: UpstreamClientOptions) {
    if (!opts.baseUrl) throw new Error("KAIMI_UPSTREAM_BASE_URL is required");
    if (!opts.apiKey) throw new Error("KAIMI_UPSTREAM_API_KEY is required");
    this.baseUrl = opts.baseUrl;
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(
    method: string,
    path: string,
    options?: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      idempotencyKey?: string;
    },
  ): Promise<T> {
    let url = joinUrl(this.baseUrl, path);
    if (options?.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(options.query)) {
        if (v === undefined || v === "") continue;
        qs.set(k, String(v));
      }
      const s = qs.toString();
      if (s) url += `?${s}`;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
    if (options?.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (options?.idempotencyKey) {
      headers["Idempotency-Key"] = options.idempotencyKey;
    }

    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { error: text };
      }
    }

    if (!res.ok) {
      throw new UpstreamError(res.status, json);
    }
    return json as T;
  }

  listPlans() {
    return this.request<{ plans?: AgentPlan[]; list?: AgentPlan[]; purchase?: unknown } | AgentPlan[]>(
      "GET",
      "/agent/plans",
    );
  }

  /** Normalize plans payload: main site returns `{ plans: [...] }`. */
  async fetchPlans(): Promise<AgentPlan[]> {
    const res = await this.listPlans();
    if (Array.isArray(res)) return res;
    if (Array.isArray(res.plans)) return res.plans;
    if (Array.isArray(res.list)) return res.list;
    return [];
  }

  listCdks(query?: {
    status?: string;
    plan?: string;
    code?: string;
    page?: number;
    page_size?: number;
  }) {
    return this.request<{
      list?: AgentCdk[];
      total?: number;
      page?: number;
      page_size?: number;
      summary?: {
        total?: number;
        unused?: number;
        reserved?: number;
        consumed?: number;
      };
    }>("GET", "/agent/cdks", { query });
  }

  /** 批量预检卡密（归属 / 套餐 / 状态），不预留。 */
  validateCdks(body: { plan: string; codes: string[] }) {
    return this.request<{
      plan: string;
      summary: {
        total_lines?: number;
        valid_count: number;
        invalid_count: number;
        valid_codes?: string[];
        invalid?: Array<{
          line?: number;
          code?: string;
          error_code?: string;
          message?: string;
        }>;
      };
      warn_batch_limit?: boolean;
      max_batch_items?: number;
    }>("POST", "/agent/cdk/validate", { body });
  }

  /** 提交前校验 ChatGPT Session（主站会向 ChatGPT 拉订阅摘要，不落库） */
  async checkSession(body: { session?: string; token_input?: string }) {
    try {
      return await this.request<{
        ok: boolean;
        email?: string;
        summary?: {
          email?: string;
          plan_type?: string;
          has_active_subscription?: boolean;
          expires_at?: string;
          account_id?: string;
          [key: string]: unknown;
        };
        error?: string;
        error_code?: string;
      }>("POST", "/agent/session/check", { body });
    } catch (err) {
      // 400 业务失败：返回结构化结果，便于前端分支
      if (err instanceof UpstreamError && err.status === 400) {
        const body = (err.body || {}) as {
          ok?: boolean;
          error?: string;
          error_code?: string;
          email?: string;
          summary?: Record<string, unknown>;
        };
        return {
          ok: false as const,
          email: body.email,
          summary: body.summary as
            | {
                email?: string;
                plan_type?: string;
                has_active_subscription?: boolean;
                expires_at?: string;
                account_id?: string;
                [key: string]: unknown;
              }
            | undefined,
          error: body.error || err.message,
          error_code: body.error_code || err.errorCode || "SESSION_INVALID",
        };
      }
      throw err;
    }
  }

  createOrder(body: { plan: string; count: number; pay_type?: "alipay" | "wxpay" }) {
    return this.request<{ order: AgentOrder; pay_url?: string }>("POST", "/agent/orders", {
      body,
    });
  }

  getOrder(orderNo: string) {
    return this.request<AgentOrder>("GET", `/agent/orders/${encodeURIComponent(orderNo)}`);
  }

  listOrders(query?: { page?: number; page_size?: number; status?: string }) {
    return this.request<{
      list?: AgentOrder[];
      total?: number;
      page?: number;
      page_size?: number;
    }>("GET", "/agent/orders", { query });
  }

  repayOrder(orderNo: string) {
    return this.request<{ order: AgentOrder; pay_url?: string }>(
      "POST",
      `/agent/orders/${encodeURIComponent(orderNo)}/repay`,
    );
  }

  createRecharge(
    body: {
      plan: string;
      cdk_code: string;
      account: AgentCredential;
      client_reference?: string;
    },
    idempotencyKey?: string,
  ) {
    return this.request<RechargeRecord>("POST", "/agent/recharge", {
      body,
      idempotencyKey,
    });
  }

  getRecharge(requestId: string) {
    return this.request<RechargeRecord>(
      "GET",
      `/agent/recharge/${encodeURIComponent(requestId)}`,
    );
  }

  listRecords(query?: {
    email?: string;
    cdk?: string;
    status?: string;
    plan?: string;
    page?: number;
    page_size?: number;
  }) {
    return this.request<{
      list?: RechargeRecord[];
      total?: number;
      page?: number;
      page_size?: number;
    }>("GET", "/agent/records", { query });
  }

  listWebhookDeliveries(query?: { page?: number; page_size?: number }) {
    return this.request<{
      list?: Array<Record<string, unknown>>;
      total?: number;
    }>("GET", "/agent/webhooks/deliveries", { query });
  }
}

export function isTerminalStatus(status?: string) {
  return status === "success" || status === "failed" || status === "skipped" || status === "unknown";
}

export function isProcessingStatus(status?: string) {
  return (
    status === "pending" ||
    status === "issuing" ||
    status === "preparing" ||
    status === "submitted" ||
    status === "processing"
  );
}
