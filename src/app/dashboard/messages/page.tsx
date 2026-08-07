import { getCurrentUser } from "@/lib/auth";
import { getUserDashboard } from "@/lib/dashboard";
import MessagesSection from "@/components/dashboard/MessagesSection";

export const dynamic = "force-dynamic";

export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ phone?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) return null;

  const params = await searchParams;
  const dash = getUserDashboard(user.id);

  return (
    <div className="space-y-6 h-[calc(100vh-8rem)]">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">Messages</h1>
        <p className="mt-1 text-sm text-white/45">SMS conversations and contacts.</p>
      </div>

      <MessagesSection
        conversations={dash.conversations}
        numbers={dash.phone_numbers}
        prefillPhone={params.phone}
      />
    </div>
  );
}
