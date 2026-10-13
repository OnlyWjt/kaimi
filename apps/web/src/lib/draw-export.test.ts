import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildDrawWorkbook, drawExportRangeError, type DrawExportRow } from "./draw-export";

const base = {
  drawNo: "DR202610130001",
  createdAt: "2026-10-13T06:20:00.000Z",
  paymentCountry: "",
  amountCents: 3500,
};

async function read(buffer: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return workbook;
}

describe("buildDrawWorkbook", () => {
  it("成品号和卡密分两张表，凭据原样写成文本", async () => {
    const rows: DrawExportRow[] = [
      {
        ...base,
        planName: "GPT 成品号",
        code: `a@b.com----=1+1----@mail----${"s".repeat(30)}`,
        finished: true,
        useLabel: "已交付",
      },
      {
        ...base,
        planName: "Plus 月卡",
        code: "0012345678901234",
        finished: false,
        useLabel: "未使用",
        amountCents: 11800,
      },
    ];
    const workbook = await read(await buildDrawWorkbook(rows));
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["成品号", "卡密"]);

    const finished = workbook.getWorksheet("成品号")!;
    // 读回来的表没有列 key，按列号取：5 邮箱、6 GPT 密码、7 邮箱密码、8 Session、9 单价
    const row = finished.getRow(2);
    expect(row.getCell(5).value).toBe("a@b.com");
    // 不能加 ' 前缀，否则代理复制出来的密码是错的
    expect(row.getCell(6).value).toBe("=1+1");
    expect(row.getCell(7).value).toBe("@mail");
    expect(row.getCell(8).value).toBe("s".repeat(30));
    expect(row.getCell(9).value).toBe(35);

    const cards = workbook.getWorksheet("卡密")!;
    // 5 付款地区、6 卡密；前导 0 不能丢
    expect(cards.getRow(2).getCell(6).value).toBe("0012345678901234");
    expect(cards.getRow(2).getCell(5).value).toBe("菲区");
  });

  it("没有数据时也有一张空表", async () => {
    const workbook = await read(await buildDrawWorkbook([]));
    expect(workbook.worksheets).toHaveLength(1);
    expect(workbook.worksheets[0].rowCount).toBe(1);
  });
});

describe("drawExportRangeError", () => {
  it("校验日期区间", () => {
    expect(drawExportRangeError("2026-10-01", "2026-10-31")).toBeNull();
    expect(drawExportRangeError("2026-10-01", "2026-11-01")).toContain("31 天");
    expect(drawExportRangeError("2026-10-05", "2026-10-01")).toContain("不能早于");
    expect(drawExportRangeError("", "2026-10-01")).toContain("请选择");
  });
});
