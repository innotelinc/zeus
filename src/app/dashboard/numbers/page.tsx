import { requireDashboardUser } from "@/lib/dashboard-auth";
import { getUserDashboard } from "@/lib/dashboard";
import PhoneSection from "@/components/dashboard/PhoneSection";

export const dynamic = "force-dynamic";

export const metadata = { title: "Phone Numbers — Zeus" };

/**
 * The account's numbers and extensions.
 *
 * It used to be the dashboard root, which made "the first screen" the numbers
 * rather than what is happening now — see `/dashboard`, the Today overview.
 * The route moved so the overview could take the root without the rail having
 * two entries pointing at different ideas of "home".
 */
export default async function NumbersPage() {
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
