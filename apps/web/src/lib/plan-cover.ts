import fs from "node:fs/promises";
import path from "node:path";
import {
  COVER_EXTS,
  type CoverExt,
  agentCoverPublicPath,
  isSafeCoverFileName,
  isSafePlanKey,
} from "@/lib/plan-cover-core";

function uploadsRoot() {
  return path.join(process.cwd(), "data", "uploads");
}

function planDir(agentId: number) {
  return path.join(uploadsRoot(), "agent", String(agentId), "plan");
}

export function coverDiskFile(agentId: number, fileName: string) {
  if (!Number.isSafeInteger(agentId) || agentId <= 0) return null;
  if (!isSafeCoverFileName(fileName)) return null;
  const root = path.resolve(planDir(agentId));
  const disk = path.resolve(root, fileName);
  if (!disk.startsWith(`${root}${path.sep}`) && disk !== root) return null;
  return disk;
}

export async function writeAgentPlanCover(input: {
  agentId: number;
  planKey: string;
  ext: CoverExt;
  bytes: Uint8Array;
}) {
  if (!isSafePlanKey(input.planKey)) {
    throw new Error("套餐无效");
  }
  const dir = planDir(input.agentId);
  await fs.mkdir(dir, { recursive: true });
  const suffix = input.ext === "jpeg" ? "jpg" : input.ext;
  const nextName = `${input.planKey}.${suffix}`;
  for (const ext of COVER_EXTS) {
    const stale = `${input.planKey}.${ext === "jpeg" ? "jpg" : ext}`;
    if (stale === nextName) continue;
    await fs.unlink(path.join(dir, stale)).catch(() => undefined);
  }
  await fs.writeFile(path.join(dir, nextName), input.bytes);
  return agentCoverPublicPath(input.agentId, input.planKey, input.ext);
}

export async function readAgentPlanCover(agentId: number, fileName: string) {
  const disk = coverDiskFile(agentId, fileName);
  if (!disk) return null;
  try {
    return await fs.readFile(disk);
  } catch {
    return null;
  }
}

export function coverContentType(fileName: string) {
  const ext = fileName.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}
