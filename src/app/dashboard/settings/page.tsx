import { getCurrentUser } from "@/lib/auth";
import SettingsClient from "@/components/dashboard/SettingsSection";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  return <SettingsClient user={user} />;
}
