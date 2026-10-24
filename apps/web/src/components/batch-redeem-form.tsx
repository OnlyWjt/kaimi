"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAskDialog } from "@/components/ask-dialog";
import {
  SessionCheckResult,
  SessionField,
  credentialName,
  readRedeemJson,
  redeemApiError,
  type SessionPreview,
} from "@/components/redeem-ui";
import { useShopToolPaths } from "@/components/use-shop-tool-paths";
import { toast } from "@/components/toast";
import { copyText } from "@/lib/copy-text";
import {
  batchRowIsCommitted,
  batchRowStateFromOrder,
  batchSubmitFailureState,
  canRetryBatchRow,
  mergeBatchPrechecks,
  PRECHECK_PLAN_LIMIT,
  takeRedeemCodes,
  type BatchRowState,
} from "@/lib/recharge-batch-core";
import { publicStatusLabel } from "@/lib/status-labels";
import { CARD_PRODUCTS, type CardProduct } from "@/lib/cardplatform/product";

type Row = {
  code: string;
  codeMasked: string;
  state: BatchRowState;
  product?: CardProduct;
  planKey: string;
  planName: string;
  message: string;
  orderNo: string;
  accountEmail: string;
};

type ValidateRow = {
  code: string;
  codeMasked: string;
  ok: boolean;
  product?: CardProduct;
  planKey: string;
  planName: string;
  orderNo: string;
  error: string;
};

type SubmitRow = {
  code: string;
  ok: boolean;
  orderNo: string;
  error: string;
};

type StatusRow = {
  orderNo: string;
  fulfillStatus: string;
  message: string;
  accountEmail: string;
};

/** 还要继续刷进度的行状态。只查不重提，unknown 依然没有重试入口。 */
const LIVE_ROW_STATES = new Set<BatchRowState>([
  "running",
  "unknown",
  "submitting",
]);

function badgeClass(state: BatchRowState) {
  if (state === "success") return "km-badge km-badge-ok";
  if (state === "failed" || state === "invalid") return "km-badge km-badge-bad";
  return "km-badge km-badge-wait";
}

export function BatchRedeemForm({
  limit,
  orderRef,
}: {
  limit: number;
  /** 从多张卡的购买订单跳进来时，卡密由这里去订单接口取，不走地址栏。 */
  orderRef?: { orderNo: string; queryToken: string };
}) {
  const { ask, dialog } = useAskDialog();
  const paths = useShopToolPaths();
  const [codeText, setCodeText] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [checked, setChecked] = useState(false);
  const [session, setSession] = useState("");
  const [email, setEmail] = useState("");
  const [preview, setPreview] = useState<SessionPreview | null>(null);
  /** 预检判定这个账号兑不了的套餐：planKey → 原因。换 Session 就作废。 */
  const [blockedPlans, setBlockedPlans] = useState<Record<string, string>>({});
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const polling = useRef(false);

  const parsed = useMemo(() => takeRedeemCodes(codeText, limit), [codeText, limit]);
  const sessionOk = Boolean(preview?.ok && preview.source === "cardplatform");
  const readyCodes = rows
    .filter((row) => row.state === "ready" && !blockedPlans[row.planKey])
    .map((row) => row.code);
  const credentialReady = Boolean(session.trim()) && sessionOk;
  // 一批只填一份凭证：ChatGPT 的 Session 兑不了 Grok 卡，混着的要分开交。
  const readyProducts = [
    ...new Set(rows.filter((row) => row.state === "ready").map((row) => row.product ?? "gpt")),
  ];
  const product: CardProduct = readyProducts[0] ?? "gpt";
  const mixedProducts =
    readyProducts.length > 1
      ? `这批卡密混了 ${readyProducts.map((item) => CARD_PRODUCTS[item].label).join("、")}，登录凭证不同，请按产品分开兑换`
      : "";
  const credName = credentialName(product);

  const stats = useMemo(() => {
    const out = { total: rows.length, ok: 0, run: 0, bad: 0, wait: 0, unsure: 0 };
    for (const row of rows) {
      if (row.state === "success") out.ok += 1;
      else if (row.state === "failed" || row.state === "invalid") out.bad += 1;
      else if (row.state === "unknown") out.unsure += 1;
      // 预检判定账号兑不了的那几张不提交，不算「待兑换」。
      else if (row.state === "ready" && blockedPlans[row.planKey]) continue;
      else if (row.state === "ready" || row.state === "pending") out.wait += 1;
      else out.run += 1;
    }
    return out;
  }, [rows, blockedPlans]);

  useEffect(() => {
    if (!orderRef?.orderNo || !orderRef.queryToken) return;
    let stopped = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/public/store-orders/${encodeURIComponent(orderRef.orderNo)}?qt=${encodeURIComponent(orderRef.queryToken)}`,
          { cache: "no-store" },
        );
        const data = await readRedeemJson(res);
        if (stopped) return;
        const codes = (Array.isArray(data.codes) ? data.codes : []) as string[];
        if (!codes.length) {
          setNote("这一单的卡密还没出齐，请回订单页等卡密出来后再来批量兑换。");
          return;
        }
        setCodeText(codes.join("\n"));
        setNote(`已带入订单 ${orderRef.orderNo} 的 ${codes.length} 张卡密。`);
      } catch {
        if (!stopped) setNote("没能自动带入这一单的卡密，请从订单页复制后粘贴到下面。");
      }
    })();
    return () => {
      stopped = true;
    };
  }, [orderRef?.orderNo, orderRef?.queryToken]);

  const refresh = useCallback(async (orderNos: string[]) => {
    if (polling.current || !orderNos.length) return;
    polling.current = true;
    try {
      const res = await fetch("/api/recharge/batch/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderNos }),
      });
      const data = await readRedeemJson(res);
      if (!res.ok) return;
      const byOrder = new Map(
        ((data.list || []) as StatusRow[]).map((item) => [item.orderNo, item]),
      );
      setRows((current) =>
        current.map((row) => {
          const found = row.orderNo ? byOrder.get(row.orderNo) : undefined;
          if (!found) return row;
          return {
            ...row,
            state: batchRowStateFromOrder(found.fulfillStatus),
            message: found.message || row.message,
            accountEmail: found.accountEmail || row.accountEmail,
          };
        }),
      );
    } catch {
      /* 网络抖动就等下一轮，不要把行改成失败 */
    } finally {
      polling.current = false;
    }
  }, []);

  // unknown 也要接着刷：服务端兜底会去卡台核对，界面上又写着「正在确认」，
  // 停在那里不动的「结果待确认」正是会让人跑去别处重提的东西。
  const liveKey = rows
    .filter((row) => row.orderNo && LIVE_ROW_STATES.has(row.state))
    .map((row) => row.orderNo)
    .join(",");

  useEffect(() => {
    if (!liveKey) return;
    const orderNos = liveKey.split(",");
    const timer = setInterval(() => void refresh(orderNos), 3000);
    return () => clearInterval(timer);
  }, [liveKey, refresh]);

  function applyValidated(list: ValidateRow[], previous: Row[]) {
    const byCode = new Map(previous.map((row) => [row.code, row]));
    return list.map<Row>((item) => {
      const before = byCode.get(item.code);
      // 校验不通过但带回了单号，说明这张已经在兑换了：接着轮询就行，绝不重提。
      // 提交时断了网的人就是靠这条路把那几张接回进度里的。
      const state: BatchRowState = item.ok
        ? "ready"
        : item.orderNo
          ? "running"
          : "invalid";
      return {
        code: item.code,
        codeMasked: item.codeMasked || item.code,
        state,
        product: item.product,
        planKey: item.planKey || "",
        planName: item.planName || "",
        message: item.ok ? "" : item.error,
        // 校验通过说明这张还没用过，之前那笔失败单的单号是旧的，别再挂着。
        orderNo: item.ok ? "" : item.orderNo,
        accountEmail: before?.accountEmail || "",
      };
    });
  }

  async function validateAll() {
    if (!parsed.codes.length) {
      setError("请填写要兑换的卡密");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/recharge/batch/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codes: parsed.codes }),
      });
      const data = await readRedeemJson(res);
      if (!res.ok) throw new Error(redeemApiError(data, "校验失败"));
      const list = (data.list || []) as ValidateRow[];
      setRows((current) => {
        const committed = new Map(
          current
            .filter((row) => batchRowIsCommitted(row.state))
            .map((row) => [row.code, row]),
        );
        return applyValidated(list, current).map(
          (row) => committed.get(row.code) ?? row,
        );
      });
      setChecked(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "校验失败");
    } finally {
      setBusy(false);
    }
  }

  /**
   * 每种套餐挑一张去预检。同一个账号，Plus 能兑不代表点数、续费也能兑，
   * 以前只拿第一张去问，混着套餐的一批要到提交后才一张张失败。
   */
  function precheckPicks() {
    const byPlan = new Map<string, Row>();
    for (const row of rows) {
      if (row.state === "ready" && !byPlan.has(row.planKey)) byPlan.set(row.planKey, row);
    }
    const picks = [...byPlan.values()].slice(0, PRECHECK_PLAN_LIMIT);
    if (picks.length) return picks.map((row) => ({ code: row.code, planKey: row.planKey, planName: row.planName }));
    const code = rows[0]?.code || parsed.codes[0] || "";
    return code ? [{ code, planKey: rows[0]?.planKey || "", planName: rows[0]?.planName || "" }] : [];
  }

  async function precheckSession() {
    const picks = precheckPicks();
    if (mixedProducts) {
      setError(mixedProducts);
      return;
    }
    if (!session.trim()) {
      setError(`请先粘贴 ${credName}`);
      return;
    }
    if (!picks.length) {
      setError("请先校验卡密");
      return;
    }
    setChecking(true);
    setError("");
    setPreview(null);
    setBlockedPlans({});
    try {
      const results: { planKey: string; planName: string; data: SessionPreview }[] = [];
      for (const pick of picks) {
        const res = await fetch("/api/recharge/session-check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session: session.trim(), code: pick.code, product }),
        });
        const data = (await readRedeemJson(res)) as SessionPreview;
        results.push({ planKey: pick.planKey, planName: pick.planName, data });
        // Session 本身不行，换哪种套餐问结论都一样，别再多打卡台。
        if (!data.ok && data.verdict !== "block") break;
      }
      const merged = mergeBatchPrechecks(results);
      const data = merged.preview;
      setPreview(data);
      setBlockedPlans(merged.blocked);
      if (data?.ok && data.email) setEmail(data.email);
      if (data && !data.ok && !data.errors?.length) {
        setError(redeemApiError(data, `${credName} 预检未通过`));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "预检失败");
    } finally {
      setChecking(false);
    }
  }

  function credentialBody() {
    return { mode: "session" as const, session: session.trim(), email: email.trim(), product };
  }

  /**
   * 提交这一批。拿不到逐张结果时整批按「结果待确认」处理：订单可能已经建好、
   * 兑换可能已经发给卡台了，重提就是让客户被扣两次。
   */
  async function submitCodes(codes: string[]) {
    if (!codes.length) return;
    const pick = new Set(codes);
    setRows((current) =>
      current.map((row) => (pick.has(row.code) ? { ...row, state: "submitting", message: "" } : row)),
    );
    let status = 0;
    try {
      const res = await fetch("/api/recharge/batch/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codes, ...credentialBody() }),
      });
      status = res.status;
      const data = await readRedeemJson(res);
      const list = (data.list || []) as SubmitRow[];
      if (!res.ok || !list.length) {
        throw new Error(redeemApiError(data, "提交失败"));
      }
      const byCode = new Map(list.map((item) => [item.code, item]));
      setRows((current) =>
        current.map((row) => {
          const found = byCode.get(row.code);
          if (!found) return row;
          if (found.ok) {
            return {
              ...row,
              state: "running",
              orderNo: found.orderNo,
              message: "已提交，正在开通",
            };
          }
          // 建单被挡下但带回了单号，说明这张已经在兑换了：接着轮询，绝不给重试入口。
          return found.orderNo
            ? {
                ...row,
                state: "running",
                orderNo: found.orderNo,
                message: found.error || "这张正在兑换，正在查询进度",
              }
            : { ...row, state: "failed", message: found.error || "提交失败" };
        }),
      );
    } catch (reason) {
      const fallback = batchSubmitFailureState({ status, hadResults: false });
      const message =
        fallback === "unknown"
          ? "没收到提交结果，正在确认，请不要重复提交"
          : reason instanceof Error
            ? reason.message
            : "提交失败";
      setRows((current) =>
        current.map((row) => (pick.has(row.code) ? { ...row, state: fallback, message } : row)),
      );
      if (fallback === "failed") setError(message);
    }
  }

  async function submitBatch() {
    if (!readyCodes.length) {
      setError("没有可兑换的卡密");
      return;
    }
    if (!credentialReady) {
      setError(`请先点击「预检 ${credName}」，通过卡台校验后再兑换`);
      return;
    }
    const account = email.trim() || "这个账号";
    const answer = await ask({
      title: "确认批量兑换",
      message: `这 ${readyCodes.length} 张卡密都会兑换到 ${account}。提交后不能撤销，请确认账号没填错。`,
      confirmLabel: "开始兑换",
    });
    if (!answer) return;
    setBusy(true);
    setError("");
    try {
      await submitCodes(readyCodes);
    } finally {
      setBusy(false);
    }
  }

  async function retryRow(row: Row) {
    if (!canRetryBatchRow(row.state)) return;
    setBusy(true);
    setError("");
    try {
      if (row.state === "invalid") {
        const res = await fetch("/api/recharge/batch/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ codes: [row.code] }),
        });
        const data = await readRedeemJson(res);
        if (!res.ok) throw new Error(redeemApiError(data, "校验失败"));
        const item = ((data.list || []) as ValidateRow[])[0];
        if (!item) throw new Error("校验失败");
        setRows((current) =>
          current.map((entry) =>
            entry.code === row.code ? applyValidated([item], [entry])[0]! : entry,
          ),
        );
        return;
      }
      if (!credentialReady) {
        setError(`请先预检 ${credName} 再重试`);
        return;
      }
      await submitCodes([row.code]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "重试失败");
    } finally {
      setBusy(false);
    }
  }

  async function copyResult() {
    const text = rows
      .map((row) =>
        [
          row.codeMasked,
          publicStatusLabel(row.state, "batch"),
          row.orderNo,
          row.message,
        ]
          .filter(Boolean)
          .join(" · "),
      )
      .join("\n");
    try {
      await copyText(text);
      toast("本批结果已复制");
    } catch {
      toast("复制失败，请手动选择", "err");
    }
  }

  function skipReason(row: Row) {
    return row.state === "ready" ? blockedPlans[row.planKey] || "" : "";
  }

  function reset() {
    setRows([]);
    setChecked(false);
    setCodeText("");
    setSession("");
    setEmail("");
    setPreview(null);
    setBlockedPlans({});
    setError("");
    setNote("");
  }

  return (
    <div className="km-rx-flow">
      {dialog}
      <section className="km-rx-card">
        <div className="km-rx-card-head">
          <h2 className="km-rx-card-title">粘贴卡密</h2>
          <p className="km-rx-card-desc">
            一行一张，也可以用逗号或空格隔开，最多 {parsed.limit} 张，重复的会自动合并。
          </p>
        </div>
        <textarea
          className="km-input km-rx-codes"
          placeholder={"ZC-XXXXXXXX-XXXX\nZC-XXXXXXXX-XXXX"}
          value={codeText}
          spellCheck={false}
          onChange={(event) => setCodeText(event.target.value)}
          aria-label="卡密列表"
        />
        <button
          type="button"
          className="km-btn km-rx-primary km-rx-codes-go"
          disabled={busy || !parsed.codes.length}
          onClick={() => void validateAll()}
        >
          {busy && !checked
            ? "校验中…"
            : parsed.codes.length
              ? `校验 ${parsed.codes.length} 张`
              : "先粘贴卡密"}
        </button>
        {note || parsed.dropped > 0 ? (
          <p className="km-rx-card-desc km-rx-codes-note">
            {note}
            {parsed.dropped > 0 ? `${note ? " · " : ""}超出上限的 ${parsed.dropped} 张没有收下` : ""}
          </p>
        ) : null}
        {error && !checked ? (
          <p className="km-rx-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      {checked ? (
        <section className="km-rx-card km-form-stack">
          <div className="km-rx-card-head">
            <h2 className="km-rx-card-title">开通账号</h2>
            <p className="km-rx-card-desc">这一批全部兑换到同一个账号，{credName} 只填一次。</p>
          </div>

          <SessionField
            product={product}
            value={session}
            onChange={(value) => {
              setSession(value);
              setPreview(null);
              setBlockedPlans({});
            }}
          />

          {preview ? <SessionCheckResult preview={preview} product={product} /> : null}

          {error ? (
            <p className="km-rx-error" role="alert">
              {error}
            </p>
          ) : null}

          {!sessionOk ? (
            <button
              type="button"
              className="km-btn km-rx-primary"
              disabled={!session.trim() || checking || busy}
              onClick={() => void precheckSession()}
            >
              {checking ? "预检中…" : session.trim() ? `预检 ${credName}` : `先粘贴 ${credName}`}
            </button>
          ) : (
            <div className="km-rx-actions">
              <button
                className="km-btn km-rx-primary"
                disabled={busy || checking || !readyCodes.length || !credentialReady}
                onClick={() => void submitBatch()}
              >
                {busy
                  ? "提交中…"
                  : readyCodes.length
                    ? `提交兑换（${readyCodes.length} 张）`
                    : rows.some((row) => batchRowIsCommitted(row.state))
                      ? "已提交，进度见下方"
                      : "没有可兑换的卡密"}
              </button>
              <button
                type="button"
                className="km-rx-link"
                disabled={!session.trim() || checking || busy}
                onClick={() => void precheckSession()}
              >
                {checking ? "预检中…" : `改了 ${credName}？重新预检`}
              </button>
            </div>
          )}
        </section>
      ) : null}

      {rows.length ? (
        <section className="km-rx-card km-rx-batch">
          <div className="km-rx-card-head km-rx-card-head-row">
            <h2 className="km-rx-card-title">本批卡密</h2>
            <div className="km-rx-batch-tools">
              <button type="button" className="km-rx-link" onClick={() => void copyResult()}>
                复制结果
              </button>
              <button type="button" className="km-rx-link" disabled={busy} onClick={reset}>
                换一批
              </button>
            </div>
          </div>
          <div className="km-rx-stats">
            {(
              [
                ["共", stats.total, ""],
                ["待兑换", stats.wait, ""],
                ["处理中", stats.run, "wait"],
                ["已成功", stats.ok, "ok"],
                ["失败", stats.bad, "bad"],
              ] as const
            ).map(([label, value, tone]) => (
              <div key={label} className={tone && value ? `km-rx-stat-${tone}` : undefined}>
                <strong>{value}</strong>
                <span>{label}</span>
              </div>
            ))}
          </div>
          {stats.unsure > 0 ? (
            <p className="km-rx-card-desc">
              有 {stats.unsure} 张结果待确认，我们正在和卡台核对，请不要重复提交。核对完会显示在下面。
            </p>
          ) : null}

          <ul className="km-rx-rows">
            {rows.map((row, index) => (
              <li key={row.code} className="km-rx-row">
                <span className="km-rx-row-no">{index + 1}</span>
                <div className="km-rx-row-main">
                  <div className="km-rx-row-head">
                    <span className="font-mono">{row.codeMasked}</span>
                    {row.planName ? <span className="km-rx-row-plan">{row.planName}</span> : null}
                    <span className={`km-rx-row-badge ${skipReason(row) ? "km-badge km-badge-bad" : badgeClass(row.state)}`}>
                      {skipReason(row) ? "跳过" : publicStatusLabel(row.state, "batch")}
                    </span>
                  </div>
                  {row.accountEmail || row.message || row.state === "unknown" || skipReason(row) ? (
                    <div className="km-rx-row-detail">
                      {row.accountEmail ? <p>账号 {row.accountEmail}</p> : null}
                      {row.message ? <p>{row.message}</p> : null}
                      {skipReason(row) ? <p className="km-rx-row-warn">这个账号兑不了，不会提交：{skipReason(row)}</p> : null}
                      {row.state === "unknown" ? <p className="km-rx-row-warn">正在确认，请不要重复提交。</p> : null}
                    </div>
                  ) : null}
                  {row.orderNo || canRetryBatchRow(row.state) ? (
                    <div className="km-rx-row-actions">
                      {row.orderNo ? <Link href={paths.lookupOrder(row.orderNo)}>查看进度</Link> : null}
                      {canRetryBatchRow(row.state) ? (
                        <button type="button" className="km-rx-link" disabled={busy} onClick={() => void retryRow(row)}>
                          {row.state === "invalid" ? "重新校验" : "重试这一张"}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
