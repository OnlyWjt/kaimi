import ExcelJS from "exceljs";

const MONEY_FORMAT = '¥#,##0.00;[Red]-¥#,##0.00';
const DANGEROUS_FORMULA_PREFIX = /^[=+\-@]/;

export type EarningsExportSummary = {
  periodStart: string;
  periodEnd: string;
  agentName: string;
  orderCount: number;
  grossCents: number;
  costCents: number;
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
  planName: string;
  paymentChannel: string;
  grossCents: number;
  costCents: number;
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
}) {
  if (input.details.length > 50_000) {
    throw new Error("单次最多导出 50,000 条收益明细，请缩小时间范围");
  }
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Kaimi";
  workbook.created = new Date();

  const summary = workbook.addWorksheet("收益汇总");
  configureSheet(summary, [
    { header: "开始时间", key: "periodStart", width: 22 },
    { header: "结束时间", key: "periodEnd", width: 22 },
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
  ]);
  summary.addRow({
    periodStart: safeText(input.summary.periodStart),
    periodEnd: safeText(input.summary.periodEnd),
    agentName: safeText(input.summary.agentName),
    orderCount: input.summary.orderCount,
    gross: yuan(input.summary.grossCents),
    cost: yuan(input.summary.costCents),
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
    { header: "收益确认时间", key: "confirmedAt", width: 22 },
    { header: "订单号", key: "orderNo", width: 25 },
    { header: "代理", key: "agentName", width: 20 },
    { header: "套餐", key: "planName", width: 18 },
    { header: "支付渠道", key: "paymentChannel", width: 14 },
    { header: "客户实付", key: "gross", width: 16 },
    { header: "代理成本", key: "cost", width: 16 },
    { header: "预计手续费", key: "estimatedFee", width: 16 },
    { header: "实际手续费", key: "actualFee", width: 16 },
    { header: "手续费对账", key: "feeStatus", width: 18 },
    { header: "最终手续费", key: "finalFee", width: 16 },
    { header: "最终收益", key: "earning", width: 16 },
    { header: "收益状态", key: "earningStatus", width: 14 },
    { header: "结算单号", key: "settlementNo", width: 24 },
    { header: "卡密状态", key: "cdkStatus", width: 14 },
  ]);
  for (const item of input.details) {
    details.addRow({
      confirmedAt: safeText(item.confirmedAt),
      orderNo: safeText(item.orderNo),
      agentName: safeText(item.agentName),
      planName: safeText(item.planName),
      paymentChannel: safeText(item.paymentChannel),
      gross: yuan(item.grossCents),
      cost: yuan(item.costCents),
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
    "estimatedFee",
    "actualFee",
    "finalFee",
    "earning",
  ]);

  const adjustments = workbook.addWorksheet("账务调整");
  configureSheet(adjustments, [
    { header: "调整时间", key: "createdAt", width: 22 },
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
      createdAt: safeText(item.createdAt),
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
    { header: "周期开始", key: "periodStart", width: 22 },
    { header: "周期结束", key: "periodEnd", width: 22 },
    { header: "结算金额", key: "amount", width: 16 },
    { header: "打款渠道", key: "paymentMethod", width: 16 },
    { header: "打款流水号", key: "paymentReference", width: 26 },
    { header: "状态", key: "status", width: 14 },
    { header: "结算时间", key: "settledAt", width: 22 },
  ]);
  for (const item of input.settlements) {
    settlements.addRow({
      settlementNo: safeText(item.settlementNo),
      agentName: safeText(item.agentName),
      periodStart: safeText(item.periodStart),
      periodEnd: safeText(item.periodEnd),
      amount: yuan(item.amountCents),
      paymentMethod: safeText(item.paymentMethod),
      paymentReference: safeText(item.paymentReference),
      status: safeText(item.status),
      settledAt: safeText(item.settledAt),
    });
  }
  formatMoneyColumns(settlements, ["amount"]);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
