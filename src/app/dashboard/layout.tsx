import type { Metadata } from "next";
import { headers } from "next/headers";
import { requireDashboardUser } from "@/lib/dashboard-auth";
import { brandNameFor } from "@/lib/resellers";
import { addonStatuses } from "@/lib/addons";
import db from "@/lib/db";
import { DashboardShell } from "@/components/dashboard/DashboardShell";
import type { FreePBXExtension, PhoneNumber } from "@/lib/types";

export const metadata: Metadata = { title: "Dashboard — Zeus" };

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireDashboardUser();

  // White-label: if this dashboard is served from a reseller domain, show
  // the reseller's brand instead of the platform brand.
  const headersList = await headers();
  const brand = brandNameFor(headersList.get("host"));

  const extensions = db
    .prepare("SELECT * FROM freepbx_extensions WHERE user_id = ? ORDER BY created_at DESC")
    .all(user.id) as FreePBXExtension[];
  const phoneNumbers = db
    .prepare("SELECT * FROM phone_numbers WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC")
    .all(user.id) as PhoneNumber[];

  // Resolved here, server-side, so the Voice and Capstone entries appear only
  // for accounts that actually hold the add-ons — and from the same helper
  // the routing path uses, so the nav can never advertise a screen whose
  // routing is refused.
  const statuses = await addonStatuses({ user: user.email });
  const voiceAddons = Object.fromEntries(
    statuses.map((status) => [status.sku, status.state]),
  );

  return (
    <DashboardShell
      user={user}
      extensions={extensions}
      phoneNumbers={phoneNumbers}
      brand={brand}
      voiceAddons={voiceAddons}
    >
      {children}
    </DashboardShell>
  );
}
