import { describe, expect, it } from "vitest";
import {
  CARDPLATFORM_LOW_BALANCE,
  CARDPLATFORM_LOW_BALANCE_WARN,
  CARDPLATFORM_UNREACHABLE,
  DEFAULT_MIN_SPENDABLE_CENTS,
  DEFAULT_WARN_SPENDABLE_CENTS,
  cardplatformRecoveredNotify,
  classifyCardplatformHealth,
  formatOpsNotifyText,
  humanizeCardplatformError,
  jobsFailedNotify,
  opsHealthNotifications,
} from "./ops-health-core";

const LINES = {
  minCents: DEFAULT_MIN_SPENDABLE_CENTS,
  warnCents: DEFAULT_WARN_SPENDABLE_CENTS,
  currency: "USD",
  hasSellablePlan: true,
};

describe("humanizeCardplatformError", () => {
  it("把超时原文翻成值班能看懂的中文", () => {
    expect(humanizeCardplatformError("The operation was aborted due to timeout")).toBe(
      "查卡台余额超时，等了 45 秒没回来。",
    );
  });

  it("已经是中文的卡台错误原样留下", () => {
    expect(humanizeCardplatformError("卡台账户未配置")).toBe("还没有配置可用的卡台账户。");
  });

  it("看不懂的英文不进通知，只提示去看日志", () => {
    expect(humanizeCardplatformError("socket hang up xyz")).toBe(
      "卡台检查失败，详细原因已写进服务器日志。",
    );
  });
});

describe("classifyCardplatformHealth", () => {
  it("余额低于 5 刀关店", () => {
    const verdict = classifyCardplatformHealth({ ...LINES, spendableCents: 320 });
    expect(verdict.closeSales).toBe(true);
    expect(verdict.issue?.code).toBe(CARDPLATFORM_LOW_BALANCE);
    expect(verdict.issue?.notify.what).toContain("3.20 USD");
    expect(verdict.issue?.notify.what).toContain("5.00 USD");
  });

  it("余额低于 150 刀只预警，店还开着", () => {
    const verdict = classifyCardplatformHealth({ ...LINES, spendableCents: 12400 });
    expect(verdict.ok).toBe(true);
    expect(verdict.closeSales).toBe(false);
    expect(verdict.issue?.code).toBe(CARDPLATFORM_LOW_BALANCE_WARN);
    expect(verdict.issue?.notify.kind).toBe("warn");
    expect(verdict.issue?.notify.action).toContain("5.00 USD");
  });

  it("余额充足不告警", () => {
    const verdict = classifyCardplatformHealth({ ...LINES, spendableCents: 20000 });
    expect(verdict.ok).toBe(true);
    expect(verdict.closeSales).toBe(false);
    expect(verdict.issue).toBeNull();
  });

  it("超时关店，并和余额告警拆开", () => {
    const verdict = classifyCardplatformHealth({
      ...LINES,
      spendableCents: null,
      error: "The operation was aborted due to timeout",
    });
    expect(verdict.issue?.code).toBe(CARDPLATFORM_UNREACHABLE);
    expect(verdict.closeSales).toBe(true);
    expect(verdict.message).not.toMatch(/timeout/i);
  });
});

describe("opsHealthNotifications", () => {
  const unreachable = classifyCardplatformHealth({
    ...LINES,
    spendableCents: null,
    error: "The operation was aborted due to timeout",
  }).issue!;
  const warn = classifyCardplatformHealth({ ...LINES, spendableCents: 8000 }).issue!;
  const recovered = cardplatformRecoveredNotify({
    spendableCents: 20000,
    currency: "USD",
    shopWasClosed: true,
  });

  it("只在跨线时推，同一条超时不连发", () => {
    const first = opsHealthNotifications(
      { salesOpen: true, cardplatformCode: null, jobsFailed: 0 },
      { salesOpen: false, cardplatformCode: CARDPLATFORM_UNREACHABLE, jobsFailed: 0 },
      unreachable,
      recovered,
      null,
    );
    expect(first).toHaveLength(1);
    expect(first[0]?.kind).toBe("alert");

    const again = opsHealthNotifications(
      { salesOpen: false, cardplatformCode: CARDPLATFORM_UNREACHABLE, jobsFailed: 0 },
      { salesOpen: false, cardplatformCode: CARDPLATFORM_UNREACHABLE, jobsFailed: 0 },
      unreachable,
      recovered,
      null,
    );
    expect(again).toEqual([]);
  });

  it("从关店恢复会再推一条", () => {
    const next = opsHealthNotifications(
      { salesOpen: false, cardplatformCode: CARDPLATFORM_UNREACHABLE, jobsFailed: 0 },
      { salesOpen: true, cardplatformCode: null, jobsFailed: 0 },
      null,
      recovered,
      null,
    );
    expect(next.map((item) => item.kind)).toEqual(["recovered"]);
    expect(next[0]?.impact).toContain("重新开放");
  });

  it("失败任务从 0 变成有才推", () => {
    const jobs = jobsFailedNotify(2);
    const first = opsHealthNotifications(
      { salesOpen: true, cardplatformCode: null, jobsFailed: 0 },
      { salesOpen: true, cardplatformCode: null, jobsFailed: 2 },
      null,
      null,
      jobs,
    );
    expect(first).toEqual([jobs]);

    const again = opsHealthNotifications(
      { salesOpen: true, cardplatformCode: null, jobsFailed: 2 },
      { salesOpen: true, cardplatformCode: null, jobsFailed: 3 },
      null,
      null,
      jobs,
    );
    expect(again).toEqual([]);
  });

  it("预警解除且店一直开着时，恢复文案不说重新开店", () => {
    const text = formatOpsNotifyText(
      cardplatformRecoveredNotify({
        spendableCents: 16000,
        currency: "USD",
        shopWasClosed: false,
      }),
    );
    expect(text).toContain("[Kaimi] 运维恢复");
    expect(text).toContain("160.00 USD");
    expect(text).toContain("预警已经解除");
    expect(text).not.toContain("OPS");
  });
});
