import { requireDashboardUser } from "@/lib/dashboard-auth";
import { getUserDashboard } from "@/lib/dashboard";
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

  return (
    <MessagesSection
      conversations={dash.conversations}
      numbers={dash.phone_numbers}
      prefillPhone={params.phone}
    />
  );
}
