import type { NextConfig } from "next";

// 后台和登录页不许被别的站点用 iframe 套住（点击劫持）。店铺页不限制，代理可能自己嵌。
const NO_FRAME = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
];

const nextConfig: NextConfig = {
  transpilePackages: ["@kaimi/themes"],
  output: "standalone",
  serverExternalPackages: ["@libsql/client"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          // 订单页地址带查询凭证 qt，跳到外站时只给来源域名，不带路径和参数。
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      { source: "/admin/:path*", headers: NO_FRAME },
      { source: "/admin", headers: NO_FRAME },
      { source: "/agent/:path*", headers: NO_FRAME },
      { source: "/agent", headers: NO_FRAME },
      { source: "/login", headers: NO_FRAME },
    ];
  },
};

export default nextConfig;
