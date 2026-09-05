import { requireDashboardUser } from "@/lib/dashboard-auth";
import { getUserDashboard } from "@/lib/dashboard";
import BillingSection from "@/components/dashboard/BillingSection";

export const dynamic = "force-dynamic";

export default async function BillingPage() {
  const user = await requireDashboardUser();
  const dash = getUserDashboard(user.id);

  return (
    <BillingSection
      user={user}
      invoices={dash.invoices}
      magnateUrl={process.env.MAGNATE_PUBLIC_URL ?? ""}
    />
  );
}
