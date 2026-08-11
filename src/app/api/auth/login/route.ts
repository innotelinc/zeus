import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import bcrypt from "bcryptjs";
import db from "@/lib/db";
import { loginSchema } from "@/lib/validators";
import { createSessionToken, SESSION_COOKIE, getSessionCookieOptions } from "@/lib/auth";
import { rateLimitByIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const headersList = await headers();
  const ip =
    headersList.get("x-forwarded-for") ??
    headersList.get("x-real-ip") ??
    "unknown";

  const limit = rateLimitByIp(ip, "login", 10, 60_000);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many login attempts. Try again shortly." },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  const { email, password } = parsed.data;
  const user = db
    .prepare("SELECT id, password_hash FROM users WHERE LOWER(email) = LOWER(?)")
    .get(email.toLowerCase()) as { id: string; password_hash: string } | undefined;

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return NextResponse.json(
      { error: "Invalid email or password." },
      { status: 401 },
    );
  }

  const store = await cookies();
  store.set(
    SESSION_COOKIE,
    createSessionToken(user.id),
    getSessionCookieOptions(headersList.get("host")),
  );

  return NextResponse.json({ success: true });
}
