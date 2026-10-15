import type { UserRole } from "@/lib/auth";
import type { DrawPlanSummary } from "@/lib/agent-draw-core";
import { decryptSecret, maskCode } from "@/lib/crypto";
import { maskFinishedEmail, splitFinishedAccountLine } from "@/lib/finished-account-core";

// 提卡账本几个模块共用的小件：错误类型、操作人、时间、打码。

export class DrawError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export type Actor = { id: number; role: UserRole };

export function nowIso() {
  return new Date().toISOString();
}

/** 展示用卡号；成品号只显示打码邮箱。密钥与数据不一致时不抛错，避免整页账本加载失败。 */
export function maskedDrawCode(encrypted: string) {
  try {
    const plain = decryptSecret(encrypted);
    const account = splitFinishedAccountLine(plain);
    return {
      codeMasked: account ? maskFinishedEmail(account.email) : maskCode(plain),
      unavailable: false,
    };
  } catch {
    return { codeMasked: "无法显示", unavailable: true };
  }
}

export function parseSummary(raw: string): DrawPlanSummary[] {
  try {
    const parsed = JSON.parse(raw) as DrawPlanSummary[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
