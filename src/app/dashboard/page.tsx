import { requireDashboardUser } from "@/lib/dashboard-auth";
import { getUserDashboard } from "@/lib/dashboard";
import PhoneSection from "@/components/dashboard/PhoneSection";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requireDashboardUser();
  const dash = getUserDashboard(user.id);

  return (
    <PhoneSection
      numbers={dash.phone_numbers}
      extensions={dash.extensions}
      plan={user.plan}
    />
  );
}
