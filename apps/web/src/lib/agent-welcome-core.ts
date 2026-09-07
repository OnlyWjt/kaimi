/** 发给代理的开户短信/微信文案。地址和账号填进去就能直接转发。 */
export function buildAgentWelcomeText(input: {
  displayName?: string;
  loginUrl: string;
  startUrl: string;
  username: string;
  password?: string;
}) {
  const name = input.displayName?.trim();
  const password = input.password?.trim();
  return [
    name ? `${name}，这是你的店铺后台。` : "这是你的店铺后台。",
    "",
    `登录：${input.loginUrl.trim()}`,
    `用户名：${input.username.trim()}`,
    password ? `密码：${password}` : "密码：用我单独发给你的那条",
    `上手说明：${input.startUrl.trim()}`,
    "",
    "登录后先改密码，再设店铺链接和零售价（必须落在可填区间里），然后把店铺链接发给客户。",
    "客户付款后自动出卡密，一张单可以买多张，不用你手动发货。",
    "客户用邮箱查单只能看到卡密后几位，完整卡密要用订单号。",
  ].join("\n");
}
