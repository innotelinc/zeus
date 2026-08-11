import { requireDashboardUser } from "@/lib/dashboard-auth";
import SettingsSection from "@/components/dashboard/SettingsSection";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requireDashboardUser();

  return <SettingsSection user={user} />;
}
