import { getCurrentUser } from "@/lib/auth";
import { getUserDashboard } from "@/lib/dashboard";
import FaxClientInterface from "@/components/dashboard/FaxSection";

export const dynamic = "force-dynamic";

export default async function FaxPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const dash = getUserDashboard(user.id);

  return (
    <FaxClientInterface
      faxAccount={dash.fax_account}
      faxes={dash.faxes}
      numbers={dash.phone_numbers}
    />
  );
}
