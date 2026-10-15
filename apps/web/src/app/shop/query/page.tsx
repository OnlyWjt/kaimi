import { redirect } from "next/navigation";

// 旧的售码订单查询页，和「订单进度」重复，统一走 /lookup。
export default function ShopQueryPage() {
  redirect("/lookup");
}
