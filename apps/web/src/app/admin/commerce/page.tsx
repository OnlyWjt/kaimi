import { redirect } from "next/navigation";

export default function AdminCommercePage() {
  redirect("/admin?tab=commerce");
}
