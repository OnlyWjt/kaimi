/** Key 规则里页面也要用的常量。别在这里引 node 模块，客户端组件会打包它。 */

/** 一把 Key 最多填几条白名单。再多基本是把整片机房都放进来了，不如不设。 */
export const MAX_ALLOWLIST_ENTRIES = 20;

/**
 * 正式 Key 从这一刻起必须设白名单（北京时间 2026-10-27 00:00）。
 * 之前建的 Key 白名单都是空的，给代理留一周改，宽限期内空白名单照常放行。
 */
export const ALLOWLIST_ENFORCED_FROM = "2026-10-26T16:00:00.000Z";
export const ALLOWLIST_ENFORCED_LABEL = "10 月 27 日";
