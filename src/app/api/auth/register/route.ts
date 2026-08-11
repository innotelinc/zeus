import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import db from "@/lib/db";
import { registerSchema } from "@/lib/validators";
import { createSessionToken, SESSION_COOKIE, getSessionCookieOptions } from "@/lib/auth";
import { rateLimitByIp } from "@/lib/rate-limit";
import { notifyAtlasSignup } from "@/lib/atlas-api";
import { buildWelcomeEmail } from "@/lib/mail-templates";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const headersList = await headers();
  const ip =
    headersList.get("x-forwarded-for") ??
    headersList.get("x-real-ip") ??
    "unknown";

  const limit = rateLimitByIp(ip, "register", 5, 60_000);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many signup attempts. Try again shortly." },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  const { name, email, password, plan, phone } = parsed.data;

  const existing = db
    .prepare("SELECT id FROM users WHERE LOWER(email) = LOWER(?)")
    .get(email) as { id: string } | undefined;
  if (existing) {
    return NextResponse.json(
      { error: "An account with this email already exists." },
      { status: 409 },
    );
  }

  const id = randomUUID();
  const passwordHash = bcrypt.hashSync(password, 10);
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, plan, phone) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, email.toLowerCase(), name, passwordHash, plan, phone ?? null);

  const store = await cookies();
  store.set(
    SESSION_COOKIE,
    createSessionToken(id),
    getSessionCookieOptions(headersList.get("host")),
  );

  // Send welcome email (async, non-blocking)
  buildWelcomeEmail({ name, email: email.toLowerCase(), plan }).catch(() => {});

  // Notify Atlas about the signup (async, don't block)
  notifyAtlasSignup({
    email: email.toLowerCase(),
    name,
    plan,
    phone: phone ?? undefined,
    pbx_user_id: id,
  }).catch(() => {
    // Non-critical — Atlas may be offline
  });

  return NextResponse.json({
    user: { id, email: email.toLowerCase(), name, plan, country: "US" },
  });
}
