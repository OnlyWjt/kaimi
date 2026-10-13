/** 买家查单页的完整链接，带查询凭证。发邮件、给代理复制都用它。 */
export function storeOrderQueryUrl(base: string, orderNo: string, queryToken: string) {
  return `${base}/shop/order/${encodeURIComponent(orderNo)}?qt=${encodeURIComponent(queryToken)}`;
}
