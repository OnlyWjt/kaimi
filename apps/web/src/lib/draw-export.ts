import ExcelJS from "exceljs";
import { formatBeijingDateTime } from "./datetime";
import { splitFinishedAccountLine } from "./finished-account-core";
import { regionDisplay } from "@/lib/cardplatform/regions";

const MONEY_FORMAT = '¥#,##0.00;[Red]-¥#,##0.00';
const DANGEROUS_FORMULA_PREFIX = /^[=+\-@]/;
export const DRAW_EXPORT_MAX_ROWS = 5000;
export const DRAW_EXPORT_MAX_DAYS = 31;

export type DrawExportRow = {
  drawNo: string;
  createdAt: string;
  planName: string;
  /** 解密后的交付内容：卡密，或 邮箱----GPT密码----邮箱密码----Session。 */
  code: string;
  finished: boolean;
  paymentCountry: string;
  useLabel: string;
  amountCents: number;
};

function safeText(value: unknown) {
  const text = String(value ?? "");
  return DANGEROUS_FORMULA_PREFIX.test(text) ? `'${text}` : text;
}

function configureSheet(sheet: ExcelJS.Worksheet, columns: Partial<ExcelJS.Column>[]) {
  sheet.columns = columns;
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { vertical: "middle" };
}

/** 文本列统一设成「@」格式，Excel 不会把长数字、像日期的密码改掉。 */
function textColumns(sheet: ExcelJS.Worksheet, keys: string[]) {
  for (const key of keys) sheet.getColumn(key).numFmt = "@";
}

/**
 * 成品号和卡密分两个工作表；哪种没有就不建那张表。都没有时留一张空的成品号表，
 * 免得打开是个没有工作表的坏文件。
 */
export async function buildDrawWorkbook(rows: DrawExportRow[]) {
  if (rows.length > DRAW_EXPORT_MAX_ROWS) {
    throw new Error(`单次最多导出 ${DRAW_EXPORT_MAX_ROWS} 条，请缩小时间范围`);
  }
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Kaimi";
  workbook.created = new Date();

  const finished = rows.filter((row) => row.finished);
  const cards = rows.filter((row) => !row.finished);

  if (finished.length > 0 || cards.length === 0) {
    const sheet = workbook.addWorksheet("成品号");
    configureSheet(sheet, [
      { header: "序号", key: "index", width: 8 },
      { header: "提取单", key: "drawNo", width: 24 },
      { header: "提取时间(北京时间)", key: "createdAt", width: 22 },
      { header: "套餐", key: "planName", width: 18 },
      { header: "邮箱", key: "email", width: 32 },
      { header: "GPT 密码", key: "gptPassword", width: 20 },
      { header: "邮箱密码", key: "mailboxPassword", width: 20 },
      { header: "Session", key: "session", width: 60 },
      { header: "单价", key: "amount", width: 12 },
    ]);
    textColumns(sheet, ["drawNo", "email", "gptPassword", "mailboxPassword", "session"]);
    finished.forEach((row, index) => {
      const parts = splitFinishedAccountLine(row.code);
      sheet.addRow({
        index: index + 1,
        drawNo: safeText(row.drawNo),
        createdAt: safeText(formatBeijingDateTime(row.createdAt)),
        planName: safeText(row.planName),
        // 凭据原样写：xlsx 的字符串单元格不会被当成公式，加 ' 反而会把「=」开头的密码改错。
        email: parts?.email ?? row.code,
        gptPassword: parts?.gptPassword ?? "",
        mailboxPassword: parts?.mailboxPassword ?? "",
        session: parts?.session ?? "",
        amount: row.amountCents / 100,
      });
    });
    sheet.getColumn("session").alignment = { wrapText: false };
    sheet.getColumn("amount").numFmt = MONEY_FORMAT;
  }

  if (cards.length > 0) {
    const sheet = workbook.addWorksheet("卡密");
    configureSheet(sheet, [
      { header: "序号", key: "index", width: 8 },
      { header: "提取单", key: "drawNo", width: 24 },
      { header: "提取时间(北京时间)", key: "createdAt", width: 22 },
      { header: "套餐", key: "planName", width: 22 },
      { header: "付款地区", key: "region", width: 10 },
      { header: "卡密", key: "code", width: 36 },
      { header: "使用状态", key: "useLabel", width: 12 },
      { header: "单价", key: "amount", width: 12 },
    ]);
    textColumns(sheet, ["drawNo", "code"]);
    cards.forEach((row, index) => {
      sheet.addRow({
        index: index + 1,
        drawNo: safeText(row.drawNo),
        createdAt: safeText(formatBeijingDateTime(row.createdAt)),
        planName: safeText(row.planName),
        region: safeText(regionDisplay(row.paymentCountry || "").zh),
        code: row.code,
        useLabel: safeText(row.useLabel),
        amount: row.amountCents / 100,
      });
    });
    sheet.getColumn("amount").numFmt = MONEY_FORMAT;
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** 北京时间日期区间是否合法：都是 YYYY-MM-DD、不倒挂、不超过上限天数。 */
export function drawExportRangeError(from: string, to: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return "请选择开始和结束日期";
  }
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return "日期无效";
  if (end < start) return "结束日期不能早于开始日期";
  const days = Math.round((end - start) / 86_400_000) + 1;
  if (days > DRAW_EXPORT_MAX_DAYS) return `一次最多导出 ${DRAW_EXPORT_MAX_DAYS} 天`;
  return null;
}
