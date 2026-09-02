import { redirect } from "next/navigation";

export default function AdminCardSelectionPage() {
  redirect("/admin?tab=selection");
}
