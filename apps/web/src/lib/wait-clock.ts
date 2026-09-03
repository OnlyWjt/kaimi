/**
 * 订单等待时长的计时。
 *
 * 等待界面横跨「正在确认订单」和「正在生成卡密」两个分支，每个分支各挂一个组件，
 * 所以起算点不能放在组件状态里 —— 那样每次切换分支都会归零，显示的就不是真实等待时长；
 * 而且如果重挂比计时器间隔还快，计时器一次都触发不了，会永远停在 0 秒。
 *
 * 这里把起算点按订单号锚在会话存储上，重挂后读回同一个锚点。
 */

export type WaitClockStorage = Pick<Storage, "getItem" | "setItem">;

function anchorKey(orderNo: string) {
  return `kaimi-order-wait:${orderNo}`;
}

/** 会话存储可能被浏览器策略禁掉，拿不到就退化成不持久化，不要让页面挂掉。 */
export function sessionWaitStorage(): WaitClockStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** 取这个订单的等待起算时间；没有就用 now 建一个并存下来。 */
export function waitAnchor(
  orderNo: string,
  storage: WaitClockStorage | null,
  now: number = Date.now(),
) {
  if (!storage || !orderNo) return now;
  const key = anchorKey(orderNo);
  try {
    const saved = Number(storage.getItem(key));
    // 未来的时间戳说明存的值不可信（改过系统时间等），重新锚一次。
    if (Number.isFinite(saved) && saved > 0 && saved <= now) return saved;
    storage.setItem(key, String(now));
    return now;
  } catch {
    return now;
  }
}

export function elapsedSeconds(anchor: number, now: number = Date.now()) {
  if (!Number.isFinite(anchor) || anchor <= 0) return 0;
  return Math.max(0, Math.floor((now - anchor) / 1000));
}

export function formatWaitLabel(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0 秒";
  if (seconds < 60) return `${Math.floor(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return rest > 0 ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
}
