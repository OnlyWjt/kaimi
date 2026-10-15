export async function register() {
  // Edge 运行时没有 node:dns，只在 Node 运行时设。
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./lib/network/prefer-ipv4");
  }
}
