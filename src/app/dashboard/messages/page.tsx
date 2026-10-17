import { requireDashboardUser } from "@/lib/dashboard-auth";
import { getUserDashboard } from "@/lib/dashboard";
import { isOpenSmsConfigured } from "@/lib/opensms";
import { smsProvider, type SmsTransportChoice } from "@/lib/sms";
import MessagesSection from "@/components/dashboard/MessagesSection";

export const dynamic = "force-dynamic";

export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ phone?: string }>;
}) {
  const user = await requireDashboardUser();
  const params = await searchParams;
  const dash = getUserDashboard(user.id);

  // The composer offers a real choice only when the local gateway is configured;
  // otherwise the picker stays on the provider path and the UI explains why.
  const localSmsConfigured = isOpenSmsConfigured();
  const configured = smsProvider();
  const preferred: SmsTransportChoice =
    configured === "opensms" && localSmsConfigured
      ? "local"
      : configured === "auto" && localSmsConfigured
        ? "auto"
        : "provider";

  return (
    <MessagesSection
      conversations={dash.conversations}
      numbers={dash.phone_numbers}
      prefillPhone={params.phone}
      localSmsConfigured={localSmsConfigured}
      defaultTransport={preferred}
    />
  );
}
