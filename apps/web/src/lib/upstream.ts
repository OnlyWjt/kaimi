import { UpstreamClient } from "@kaimi/upstream";
import { getAppConfig } from "@/lib/config";
import { decryptSecret } from "@/lib/crypto";

export async function getUpstreamClient() {
  const cfg = await getAppConfig();
  if (!cfg.upstreamBaseUrl || !cfg.upstreamApiKey) {
    throw new Error("上游未配置：请先在向导或后台填写主站 URL 与 API Key");
  }
  return new UpstreamClient({
    baseUrl: cfg.upstreamBaseUrl,
    apiKey: decryptSecret(cfg.upstreamApiKey),
  });
}
