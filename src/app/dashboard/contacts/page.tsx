import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";
import ContactsSection from "@/components/dashboard/ContactsSection";
import type { Contact } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ContactsPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const contacts = db
    .prepare(
      "SELECT * FROM contacts WHERE user_id = ? ORDER BY name COLLATE NOCASE ASC",
    )
    .all(user.id) as Contact[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Contacts
        </h1>
        <p className="mt-1 text-sm text-white/45">
          Manage your contacts. Names sync to your SMS conversations automatically.
        </p>
      </div>

      <ContactsSection contacts={contacts} />
    </div>
  );
}
