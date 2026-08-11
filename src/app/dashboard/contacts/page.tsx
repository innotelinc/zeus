import { requireDashboardUser } from "@/lib/dashboard-auth";
import db from "@/lib/db";
import ContactsSection from "@/components/dashboard/ContactsSection";
import type { Contact } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ContactsPage() {
  const user = await requireDashboardUser();

  const contacts = db
    .prepare("SELECT * FROM contacts WHERE user_id = ? ORDER BY name COLLATE NOCASE ASC")
    .all(user.id) as Contact[];

  return <ContactsSection contacts={contacts} />;
}
