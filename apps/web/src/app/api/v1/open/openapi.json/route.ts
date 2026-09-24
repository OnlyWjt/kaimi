import { openApiSpec } from "@/lib/open-api/spec";

export function GET() {
  return Response.json(openApiSpec);
}
