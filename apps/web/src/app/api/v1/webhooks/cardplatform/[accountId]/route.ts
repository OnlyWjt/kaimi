import { ingestCardplatformWebhook } from "@/lib/cardplatform/webhook";
import { bootDb } from "@/lib/config";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  await bootDb();
  const raw = await req.text();
  const { accountId } = await params;
  const result = await ingestCardplatformWebhook({
    raw,
    headers: req.headers,
    slug: accountId,
  });
  return new Response(null, { status: result.status });
}
