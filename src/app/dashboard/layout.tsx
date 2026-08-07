import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";
import { DashboardShell } from "@/components/dashboard/DashboardShell";
import type { FreePBXExtension } from "@/lib/types";

export const metadata: Metadata = { title: "Dashboard — Innotel" };

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/dashboard");

  const extensions = db
    .prepare("SELECT * FROM freepbx_extensions WHERE user_id = ? ORDER BY created_at DESC")
    .all(user.id) as FreePBXExtension[];

  return (
    <DashboardShell user={user} extensions={extensions}>
      {children}
    </DashboardShell>
  );
}
