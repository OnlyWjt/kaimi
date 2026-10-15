import { redirect } from "next/navigation";

// 旧的内部发卡页已下线，买卡都在代理店铺 /s/{slug}。老链接回首页（兑换、查进度入口都在那）。
export default function ShopPage() {
  redirect("/");
}
