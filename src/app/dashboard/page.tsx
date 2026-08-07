import { getCurrentUser } from "@/lib/auth";
import { getUserDashboard } from "@/lib/dashboard";
import PhoneSection from "@/components/dashboard/PhoneSection";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const dash = getUserDashboard(user.id);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Phone Numbers
        </h1>
        <p className="mt-1 text-sm text-white/45">
          Manage your DIDs and FreePBX extensions.
        </p>
      </div>

      <PhoneSection
        numbers={dash.phone_numbers}
        extensions={dash.extensions}
        plan={user.plan}
      />
    </div>
  );
}
