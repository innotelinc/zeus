import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, getSessionCookieOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const headersList = await headers();
  const store = await cookies();
  const opts = getSessionCookieOptions(headersList.get("host"));
  store.set(SESSION_COOKIE, "", { ...opts, maxAge: 0 });
  redirect("/");
}
