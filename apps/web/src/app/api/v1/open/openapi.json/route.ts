import { openApiSpec } from "@/lib/open-api/spec";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { agentCanSeeDrawApi } from "@/lib/open-api/draw-access";

export async function GET() {
  const spec = JSON.parse(JSON.stringify(openApiSpec)) as typeof openApiSpec & {
    paths: Record<string, unknown>;
  };
  let includeDraw = false;
  try {
    const session = await requireAgent();
    await bootDb();
    includeDraw = await agentCanSeeDrawApi(session.agentId);
  } catch {
    includeDraw = false;
  }
  if (!includeDraw) {
    for (const key of Object.keys(spec.paths)) {
      if (key.startsWith("/draws")) delete spec.paths[key];
    }
  }
  return Response.json(spec);
}
