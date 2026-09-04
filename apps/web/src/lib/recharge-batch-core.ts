/** 一次批量兑换最多几张由后台配置，没配过就按 20 张。 */
export const DEFAULT_BATCH_REDEEM_LIMIT = 20;

/** 后台填错一个数字不能让一次点击去打卡台几百次，无论怎么填都不会超过这里。 */
export const HARD_MAX_BATCH_REDEEM_LIMIT = 50;

/** 卡台 preview 最短只认 6 位，比这更短的一定是粘贴时带进来的杂字符。 */
const MIN_CODE_LENGTH = 6;

/** 卡台一次只受理一张，批量就是并发跑单张链路；这个数照抄同源项目的并发度。 */
export const REDEEM_BATCH_CONCURRENCY = 6;

/** 后台填的上限：非数字、小于 1、空值都回落到默认值，再夹进硬上限。 */
export function normalizeBatchRedeemLimit(value: unknown) {
  const parsed =
    typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(parsed)) return DEFAULT_BATCH_REDEEM_LIMIT;
  const whole = Math.trunc(parsed);
  if (whole < 1) return DEFAULT_BATCH_REDEEM_LIMIT;
  return Math.min(whole, HARD_MAX_BATCH_REDEEM_LIMIT);
}

/**
 * 买家是从聊天记录、表格里整段粘过来的，所以空白、逗号、分号（含全角、顿号）
 * 都当分隔符。卡密本身不区分大小写，统一大写后再去重，免得同一张算成两张。
 */
export function parseRedeemCodes(raw: string) {
  const seen = new Set<string>();
  const codes: string[] = [];
  for (const piece of String(raw ?? "").split(/[\s,;、，；]+/)) {
    const code = piece.trim().toUpperCase();
    if (code.length < MIN_CODE_LENGTH) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return codes;
}

/** 超出上限时只收前 limit 张，多出来几张要说清楚，别默默丢掉。 */
export function takeRedeemCodes(raw: string, limit: unknown) {
  const max = normalizeBatchRedeemLimit(limit);
  const all = parseRedeemCodes(raw);
  return {
    codes: all.slice(0, max),
    dropped: Math.max(0, all.length - max),
    limit: max,
  };
}

/** 接口收到的是数组，同样要去重、规范化再夹进上限，不能信前端夹过了。 */
export function clampRedeemCodes(codes: unknown, limit: unknown) {
  const list = Array.isArray(codes) ? codes : [];
  return takeRedeemCodes(list.map((item) => String(item ?? "")).join("\n"), limit);
}

export type BatchRowState =
  | "pending"
  | "checking"
  | "invalid"
  | "ready"
  | "submitting"
  | "running"
  | "success"
  | "failed"
  | "unknown";

/** 订单 fulfill_status → 批量列表的行状态。认不出来一律当进行中，绝不当成失败。 */
export function batchRowStateFromOrder(status: string): BatchRowState {
  const value = (status || "").trim().toLowerCase();
  if (value === "success" || value === "skipped" || value === "fulfilled") {
    return "success";
  }
  if (value === "failed") return "failed";
  if (value === "unknown") return "unknown";
  return "running";
}

/**
 * 界面上「重试」按钮的唯一判据。
 *
 * 卡台把「确定失败」和「结果未知」分得很清楚：unknown 代表超时、断网或卡台还在
 * review，这一张可能已经扣过费了，重提就是让客户被扣两次。所以未知只许查，不许重提。
 */
export function canRetryBatchRow(state: BatchRowState) {
  return state === "invalid" || state === "failed";
}

/**
 * 这一行已经交给卡台了。重新校验整批时不能把它冲回「待校验」——它有单号、可能
 * 正在开通，也可能已经开通完了，只能继续查。
 */
export function batchRowIsCommitted(state: BatchRowState) {
  return (
    state === "submitting" ||
    state === "running" ||
    state === "success" ||
    state === "unknown"
  );
}

/**
 * 批量提交没能拿到逐张结果时，这一批算失败还是算未知。
 *
 * 只有两种情况可以确定「什么都没发生」：服务端明确逐张回了结果，或者请求在建单之前
 * 就被挡下来了（参数不合法、未登录、限流）。其余情况——超时、断网、5xx——订单可能
 * 已经建好、兑换可能已经交给卡台，只能去查单，绝不能重提。
 */
export function batchSubmitFailureState(input: {
  /** 没拿到 HTTP 响应（断网、超时）时传 0。 */
  status: number;
  /** 响应里带了逐张结果数组。 */
  hadResults: boolean;
}): BatchRowState {
  if (input.hadResults) return "failed";
  if ([400, 401, 403, 404, 422, 429].includes(input.status)) return "failed";
  return "unknown";
}

/** 有界并发：卡台单张链路最长两次 45 秒，放开跑会把上游和本地连接池打满。 */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await worker(items[index]!, index);
      }
    }),
  );
  return results;
}
