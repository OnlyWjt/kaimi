import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** 旧 danewcdk Agent webhook 已停用；兑换进度改走卡台 public result。 */
export async function POST() {
  return NextResponse.json(
    {
      error: "danewcdk webhook 已停用。请在后台「接入卡台」配置卡台，兑换走卡台 public CDK 接口。",
    },
    { status: 410 },
  );
}
