import { readFileSync } from "node:fs";

/** 对账逻辑拆在三个文件里；按源码断言的契约测试把它们合起来看。 */
export function reconciliationSource() {
  return ["./reconciliation-lines.ts", "./reconciliation-queries.ts", "./reconciliation.ts"]
    .map((file) => readFileSync(new URL(file, import.meta.url), "utf8"))
    .join("\n");
}
