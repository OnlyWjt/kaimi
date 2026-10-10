import { redirect } from "next/navigation";

export default function AdminAgentSettlementPage() {
  redirect("/admin#reconcile");
}