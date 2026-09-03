import { ingestCardplatformWebhook } from "@/lib/cardplatform/webhook";
import { bootDb } from "@/lib/config";

export async function POST(req: Request) {
  await bootDb();
  const raw = await req.text();
  const result = await ingestCardplatformWebhook({
    raw,
    headers: req.headers,
  });
  return new Response(null, { status: result.status });
}
