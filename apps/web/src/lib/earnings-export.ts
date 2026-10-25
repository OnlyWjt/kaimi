import ExcelJS from "exceljs";
import { formatBeijingDateTime, formatUtcDate } from "./datetime";

const MONEY_FORMAT = '¥#,##0.00;[Red]-¥#,##0.00';
const DANGEROUS_FORMULA_PREFIX = /^[=+\-@]/;

export type EarningsExportSummary = {
  periodStart: string;
  periodEnd: string;
  agentName: string;
  orderCount: number;
  grossCents: number;
  costCents: number;
  invoiceShareCents?: number;
  estimatedFeeCents: number;
  actualFeeCents: number;
  feeDifferenceCents: number;
  earningCents: number;
  pendingCents: number;
  settledCents: number;
  reversedCents: number;
  adjustmentCents?: number;
};

export type EarningsExportDetail = {
  confirmedAt: string;
  orderNo: string;
  agentName: string;
  agentId?: number;
  username?: string;
  realName?: string;
  shopName?: string;
  settlementName?: string;
  settlementMethod?: string;
  settlementAccount?: string;
  planName: string;
  paymentChannel: string;
  grossCents: number;
  costCents: number;
  /** 开票分成（扣税后），老规则单是 0。 */
  invoiceShareCents?: number;
  upstreamCostCents?: number | null;
  platformFeeCents?: number | null;
  platformProfitCents?: number | null;
  estimatedFeeCents: number;
  actualFeeCents: number | null;
  feeReconcileStatus: string;
  finalFeeCents: number;
  earningCents: number;
  earningStatus: string;
  settlementNo: string;
  cdkStatus: string;
};

export type EarningsExportSettlement = {
  settlementNo: string;
  agentName: string;
  periodStart: string;
  periodEnd: string;
  amountCents: number;
  paymentMethod: string;
  paymentReference: string;
  status: string;
  settledAt: string;
};

/** 管理员导出才有：平台这段时间的实际收益（店铺毛利 + 代理自助提卡毛利）。 */
export type EarningsExportPlatform = {
  storeProfitCents: number;
  storeProfitUnknownCount: number;
  drawItemCount: number;
  drawAmountCents: number;
  drawUpstreamCents: number;
  drawProfitCents: number;
  drawProfitUnknownCount: number;
  drawUnsettledCents: number;
  drawSettledCents: number;
  drawVoidCount: number;
};

export type EarningsExportDrawItem = {
  createdAt: string;
  drawNo: string;
  agentName: string;
  planName: string;
  amountCents: number;
  upstreamCostCents: number | null;
  /** unsettled / settled / void */
  status: string;
  voidReason: string;
};

const DRAW_STATUS_LABEL: Record<string, string> = {
  unsettled: "未结算",
  settled: "已结算",
  void: "已作废",
};

export type EarningsExportAdjustment = {
  createdAt: string;
  orderNo: string;
  agentName: string;
  type: string;
  amountCents: number;
  reason: string;
  reference: string;
  status: string;
  settlementNo: string;
};

function safeText(value: unknown) {
  const text = String(value ?? "");
  return DANGEROUS_FORMULA_PREFIX.test(text) ? `'${text}` : text;
}

function yuan(cents: number) {
  return cents / 100;
}

/** 导出文件在服务端生成，没有查看者时区，所以时间点一律按北京时间落格。 */
function stamp(value: string) {
  return safeText(formatBeijingDateTime(value));
}

function configureSheet(
  sheet: ExcelJS.Worksheet,
  columns: Partial<ExcelJS.Column>[],
) {
  sheet.columns = columns;
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columns.length },
  };
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { vertical: "middle" };
}

function formatMoneyColumns(sheet: ExcelJS.Worksheet, keys: string[]) {
  for (const key of keys) {
    sheet.getColumn(key).numFmt = MONEY_FORMAT;
  }
}

export async function buildEarningsWorkbook(input: {
  summary: EarningsExportSummary;
  details: EarningsExportDetail[];
  settlements: EarningsExportSettlement[];
  adjustments?: EarningsExportAdjustment[];
  includeAdminIdentity?: boolean;
  /** 管理员导出传：多出「平台收益」「提卡明细」两张表，放在最后，不打乱已有表的位置。 */
  platform?: EarningsExportPlatform;
  drawItems?: EarningsExportDrawItem[];
}) {
  if (input.details.length > 50_000) {
    throw new Error("单次最多导出 50,000 条收益明细，请缩小时间范围");
  }
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Kaimi";
  workbook.created = new Date();

  const summary = workbook.addWorksheet("收益汇总");
  configureSheet(summary, [
    { header: "开始日期", key: "periodStart", width: 22 },
    { header: "结束日期", key: "periodEnd", width: 22 },
    { header: "代理", key: "agentName", width: 20 },
    { header: "成交订单数", key: "orderCount", width: 14 },
    { header: "客户实付", key: "gross", width: 16 },
    { header: "代理成本", key: "cost", width: 16 },
    { header: "预计手续费", key: "estimatedFee", width: 16 },
    { header: "实际手续费", key: "actualFee", width: 16 },
    { header: "手续费差额", key: "feeDifference", width: 16 },
    { header: "最终收益", key: "earning", width: 16 },
    { header: "待结算", key: "pending", width: 16 },
    { header: "已结算", key: "settled", width: 16 },
    { header: "已冲正", key: "reversed", width: 16 },
    { header: "账务调整", key: "adjustment", width: 16 },
    // 新列一律加在最后，按列位置读这张表的脚本不会错位
    { header: "开票分成", key: "invoiceShare", width: 16 },
  ]);
  summary.addRow({
    periodStart: safeText(formatUtcDate(input.summary.periodStart)),
    periodEnd: safeText(formatUtcDate(input.summary.periodEnd)),
    agentName: safeText(input.summary.agentName),
    orderCount: input.summary.orderCount,
    gross: yuan(input.summary.grossCents),
    cost: yuan(input.summary.costCents),
    invoiceShare: yuan(input.summary.invoiceShareCents || 0),
    estimatedFee: yuan(input.summary.estimatedFeeCents),
    actualFee: yuan(input.summary.actualFeeCents),
    feeDifference: yuan(input.summary.feeDifferenceCents),
    earning: yuan(input.summary.earningCents),
    pending: yuan(input.summary.pendingCents),
    settled: yuan(input.summary.settledCents),
    reversed: yuan(input.summary.reversedCents),
    adjustment: yuan(input.summary.adjustmentCents || 0),
  });
  formatMoneyColumns(summary, [
    "gross",
    "cost",
    "invoiceShare",
    "estimatedFee",
    "actualFee",
    "feeDifference",
    "earning",
    "pending",
    "settled",
    "reversed",
    "adjustment",
  ]);

  const details = workbook.addWorksheet("收益明细");
  configureSheet(details, [
    { header: "收益确认时间(北京时间)", key: "confirmedAt", width: 24 },
    { header: "订单号", key: "orderNo", width: 25 },
    { header: "代理", key: "agentName", width: 20 },
    ...(input.includeAdminIdentity
      ? [
          { header: "代理ID", key: "agentId", width: 12 },
          { header: "登录名", key: "username", width: 16 },
          { header: "真实姓名", key: "realName", width: 16 },
          { header: "店名", key: "shopName", width: 16 },
          { header: "收款人", key: "settlementName", width: 16 },
          { header: "收款方式", key: "settlementMethod", width: 16 },
          { header: "收款账号", key: "settlementAccount", width: 24 },
        ]
      : []),
    { header: "套餐", key: "planName", width: 18 },
    { header: "支付渠道", key: "paymentChannel", width: 14 },
    { header: "客户实付", key: "gross", width: 16 },
    { header: "代理成本", key: "cost", width: 16 },
    { header: "上游进价", key: "upstream", width: 16 },
    { header: "平台手续费", key: "platformFee", width: 16 },
    { header: "平台毛利", key: "platformProfit", width: 16 },
    { header: "预计手续费", key: "estimatedFee", width: 16 },
    { header: "实际手续费", key: "actualFee", width: 16 },
    { header: "手续费对账", key: "feeStatus", width: 18 },
    { header: "最终手续费", key: "finalFee", width: 16 },
    { header: "最终收益", key: "earning", width: 16 },
    { header: "收益状态", key: "earningStatus", width: 14 },
    { header: "结算单号", key: "settlementNo", width: 24 },
    { header: "卡密状态", key: "cdkStatus", width: 14 },
    { header: "开票分成", key: "invoiceShare", width: 16 },
  ]);
  for (const item of input.details) {
    details.addRow({
      confirmedAt: stamp(item.confirmedAt),
      orderNo: safeText(item.orderNo),
      agentName: safeText(item.agentName),
      agentId: item.agentId ?? "",
      username: safeText(item.username || ""),
      realName: safeText(item.realName || ""),
      shopName: safeText(item.shopName || ""),
      settlementName: safeText(item.settlementName || ""),
      settlementMethod: safeText(item.settlementMethod || ""),
      settlementAccount: safeText(item.settlementAccount || ""),
      planName: safeText(item.planName),
      paymentChannel: safeText(item.paymentChannel),
      gross: yuan(item.grossCents),
      cost: yuan(item.costCents),
      invoiceShare: yuan(item.invoiceShareCents || 0),
      upstream: item.upstreamCostCents == null ? null : yuan(item.upstreamCostCents),
      platformFee: yuan(item.platformFeeCents || 0),
      platformProfit:
        item.platformProfitCents == null ? null : yuan(item.platformProfitCents),
      estimatedFee: yuan(item.estimatedFeeCents),
      actualFee:
        item.actualFeeCents === null ? null : yuan(item.actualFeeCents),
      feeStatus: safeText(item.feeReconcileStatus),
      finalFee: yuan(item.finalFeeCents),
      earning: yuan(item.earningCents),
      earningStatus: safeText(item.earningStatus),
      settlementNo: safeText(item.settlementNo),
      cdkStatus: safeText(item.cdkStatus),
    });
  }
  formatMoneyColumns(details, [
    "gross",
    "cost",
    "invoiceShare",
    "upstream",
    "platformFee",
    "platformProfit",
    "estimatedFee",
    "actualFee",
    "finalFee",
    "earning",
  ]);

  const adjustments = workbook.addWorksheet("账务调整");
  configureSheet(adjustments, [
    { header: "调整时间(北京时间)", key: "createdAt", width: 22 },
    { header: "订单号", key: "orderNo", width: 25 },
    { header: "代理", key: "agentName", width: 20 },
    { header: "类型", key: "type", width: 16 },
    { header: "调整金额", key: "amount", width: 16 },
    { header: "原因", key: "reason", width: 36 },
    { header: "外部参考号", key: "reference", width: 26 },
    { header: "状态", key: "status", width: 14 },
    { header: "结算单号", key: "settlementNo", width: 24 },
  ]);
  for (const item of input.adjustments || []) {
    adjustments.addRow({
      createdAt: stamp(item.createdAt),
      orderNo: safeText(item.orderNo),
      agentName: safeText(item.agentName),
      type: safeText(item.type),
      amount: yuan(item.amountCents),
      reason: safeText(item.reason),
      reference: safeText(item.reference),
      status: safeText(item.status),
      settlementNo: safeText(item.settlementNo),
    });
  }
  formatMoneyColumns(adjustments, ["amount"]);

  const settlements = workbook.addWorksheet("结算记录");
  configureSheet(settlements, [
    { header: "结算单号", key: "settlementNo", width: 24 },
    { header: "代理", key: "agentName", width: 20 },
    { header: "周期开始", key: "periodStart", width: 16 },
    { header: "周期结束", key: "periodEnd", width: 16 },
    { header: "结算金额", key: "amount", width: 16 },
    { header: "打款渠道", key: "paymentMethod", width: 16 },
    { header: "打款流水号", key: "paymentReference", width: 26 },
    { header: "状态", key: "status", width: 14 },
    { header: "结算时间(北京时间)", key: "settledAt", width: 22 },
  ]);
  for (const item of input.settlements) {
    settlements.addRow({
      settlementNo: safeText(item.settlementNo),
      agentName: safeText(item.agentName),
      periodStart: safeText(formatUtcDate(item.periodStart)),
      periodEnd: safeText(formatUtcDate(item.periodEnd)),
      amount: yuan(item.amountCents),
      paymentMethod: safeText(item.paymentMethod),
      paymentReference: safeText(item.paymentReference),
      status: safeText(item.status),
      settledAt: stamp(item.settledAt),
    });
  }
  formatMoneyColumns(settlements, ["amount"]);

  if (input.platform) {
    const p = input.platform;
    const platform = workbook.addWorksheet("平台收益");
    configureSheet(platform, [
      { header: "项目", key: "label", width: 22 },
      { header: "数值", key: "value", width: 18 },
      { header: "说明", key: "note", width: 48 },
    ]);
    const money = (label: string, cents: number, note = "") => {
      const row = platform.addRow({ label, value: yuan(cents), note });
      row.getCell("value").numFmt = MONEY_FORMAT;
    };
    const count = (label: string, value: number, note = "") => platform.addRow({ label, value, note });
    money("平台实际收益", p.storeProfitCents + p.drawProfitCents, "店铺毛利 + 提卡毛利");
    money("店铺毛利", p.storeProfitCents, "代理成本 + 平台开票收入 − 上游进价 − 平台手续费");
    count("店铺未配进价单数", p.storeProfitUnknownCount, "这几单没算进店铺毛利");
    money("提卡毛利", p.drawProfitCents, "提卡价 − 出卡时的上游成本，按出卡日期算，没结算的也算");
    count("提卡张数", p.drawItemCount, "不含作废");
    money("提卡额", p.drawAmountCents, "代理该付给平台的");
    money("提卡上游成本", p.drawUpstreamCents);
    money("提卡未结算", p.drawUnsettledCents);
    money("提卡已结算", p.drawSettledCents);
    count("提卡没有上游成本张数", p.drawProfitUnknownCount, "这几张没算进提卡毛利");
    count("提卡作废张数", p.drawVoidCount, "作废的不计费也不算收益");
    platform.getRow(2).font = { bold: true };
  }

  if (input.drawItems) {
    const draws = workbook.addWorksheet("提卡明细");
    configureSheet(draws, [
      { header: "出卡时间(北京时间)", key: "createdAt", width: 22 },
      { header: "提卡单号", key: "drawNo", width: 26 },
      { header: "代理", key: "agentName", width: 24 },
      { header: "套餐", key: "planName", width: 26 },
      { header: "提卡价", key: "amount", width: 14 },
      { header: "上游成本", key: "upstream", width: 14 },
      { header: "毛利", key: "profit", width: 14 },
      { header: "状态", key: "status", width: 12 },
      { header: "作废原因", key: "voidReason", width: 30 },
    ]);
    for (const item of input.drawItems) {
      const voided = item.status === "void";
      draws.addRow({
        createdAt: stamp(item.createdAt),
        drawNo: safeText(item.drawNo),
        agentName: safeText(item.agentName),
        planName: safeText(item.planName),
        amount: yuan(item.amountCents),
        upstream: item.upstreamCostCents == null ? null : yuan(item.upstreamCostCents),
        profit: voided || item.upstreamCostCents == null ? null : yuan(item.amountCents - item.upstreamCostCents),
        status: safeText(DRAW_STATUS_LABEL[item.status] || item.status),
        voidReason: safeText(item.voidReason),
      });
    }
    formatMoneyColumns(draws, ["amount", "upstream", "profit"]);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
