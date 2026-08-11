import { requireDashboardUser } from "@/lib/dashboard-auth";
import { getUserDashboard } from "@/lib/dashboard";
import VoicemailSection from "@/components/dashboard/VoicemailSection";

export const dynamic = "force-dynamic";

export default async function VoicemailPage() {
  const user = await requireDashboardUser();
  const dash = getUserDashboard(user.id);

  return <VoicemailSection voicemails={dash.voicemails} />;
}
