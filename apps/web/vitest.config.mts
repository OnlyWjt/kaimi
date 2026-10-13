import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 和 tsconfig 的 paths 保持一致，测试里才能直接引用 @/ 开头的业务模块。
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: fileURLToPath(new URL("./src/", import.meta.url)) },
      {
        find: "@kaimi/themes",
        replacement: fileURLToPath(new URL("../../packages/themes/src/index.ts", import.meta.url)),
      },
    ],
  },
});
