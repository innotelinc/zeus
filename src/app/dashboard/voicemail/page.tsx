import { getCurrentUser } from "@/lib/auth";
import { getUserDashboard } from "@/lib/dashboard";
import VoicemailClient from "@/components/dashboard/VoicemailSection";

export const dynamic = "force-dynamic";

export default async function VoicemailPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const dash = getUserDashboard(user.id);

  return <VoicemailClient voicemails={dash.voicemails} />;
}
