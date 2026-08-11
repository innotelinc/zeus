import { requireDashboardUser } from "@/lib/dashboard-auth";
import { getUserDashboard } from "@/lib/dashboard";
import FaxSection from "@/components/dashboard/FaxSection";

export const dynamic = "force-dynamic";

export default async function FaxPage() {
  const user = await requireDashboardUser();
  const dash = getUserDashboard(user.id);

  return (
    <FaxSection
      faxAccount={dash.fax_account}
      faxes={dash.faxes}
      numbers={dash.phone_numbers}
    />
  );
}
