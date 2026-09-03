import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@kaimi/themes"],
  output: "standalone",
  serverExternalPackages: ["@libsql/client"],
};

export default nextConfig;
