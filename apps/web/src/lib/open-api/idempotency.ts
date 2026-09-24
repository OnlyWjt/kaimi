import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { apiIdempotency } from "@/db/schema";
import { hashLookupValue } from "@/lib/crypto";
import { openFail } from "./respond";

function replayResponse(status: number, responseJson: string) {
  return new NextResponse(responseJson, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * 先插入 status=0 的占位行抢占唯一键。并发的第二个请求读到占位行时返回 409。
 */
export async function claimIdempotent(input: {
  keyId: number;
  idemKey: string;
  body: string;
}) {
  const requestHash = hashLookupValue(input.body);
  try {
    await db.insert(apiIdempotency).values({
      keyId: input.keyId,
      idemKey: input.idemKey,
      requestHash,
      status: 0,
      responseJson: "",
    });
    return { requestHash, replay: null as NextResponse | null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/UNIQUE|unique/i.test(message)) throw error;
  }
  const existing = await db.query.apiIdempotency.findFirst({
    where: and(
      eq(apiIdempotency.keyId, input.keyId),
      eq(apiIdempotency.idemKey, input.idemKey),
    ),
  });
  if (!existing) {
    return {
      requestHash,
      replay: openFail("CONFLICT", "请求处理中"),
    };
  }
  if (existing.requestHash !== requestHash) {
    return {
      requestHash,
      replay: openFail("CONFLICT", "同一个 Idempotency-Key 不能用于不同的请求"),
    };
  }
  if (existing.status === 0) {
    return {
      requestHash,
      replay: openFail("CONFLICT", "请求处理中"),
    };
  }
  return {
    requestHash,
    replay: replayResponse(existing.status, existing.responseJson),
  };
}

export async function storeIdempotent(input: {
  keyId: number;
  idemKey: string;
  requestHash: string;
  status: number;
  responseJson: string;
}) {
  await db
    .update(apiIdempotency)
    .set({
      requestHash: input.requestHash,
      status: input.status,
      responseJson: input.responseJson,
    })
    .where(
      and(eq(apiIdempotency.keyId, input.keyId), eq(apiIdempotency.idemKey, input.idemKey)),
    );
}
