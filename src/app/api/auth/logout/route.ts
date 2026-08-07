import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  redirect("/");
}
