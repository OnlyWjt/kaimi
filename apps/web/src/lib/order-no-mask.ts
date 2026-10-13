/**
 * 按邮箱查单时给买家看的订单号。
 *
 * 完整订单号就是取卡密的凭证（随机部分约 50 bit），只凭邮箱不能拿到它，
 * 否则知道别人邮箱就能把他的卡取走。留前缀日期和末 4 位，够买家认出是哪一单。
 */
export function maskOrderNo(orderNo: string) {
  const value = orderNo.trim();
  if (value.length <= 10) return value.length > 4 ? `…${value.slice(-4)}` : value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
