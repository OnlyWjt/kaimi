export async function register() {
  // Edge 运行时没有 node:dns。这里按运行时动态取，不静态引 prefer-ipv4，
  // 否则 Edge 那份 instrumentation 编译时也会把 node:dns 带进去报错。
  // 走 lib/config 的请求和脚本另外会引 prefer-ipv4，效果一样。
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const dns = await import("node:dns");
    dns.setDefaultResultOrder("ipv4first");
  }
}
