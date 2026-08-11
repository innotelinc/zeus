import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import type { User } from "@/lib/types";

/**
 * Require an authenticated user for dashboard pages.
 * Redirects to /login if no valid session, instead of silently
 * returning null (which causes blank pages).
 */
export async function requireDashboardUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login?next=/dashboard");
  }
  return user;
}
