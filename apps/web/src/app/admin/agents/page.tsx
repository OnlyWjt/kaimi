import { redirect } from "next/navigation";

export default function AdminAgentsPage() {
  redirect("/admin?tab=agents");
}
