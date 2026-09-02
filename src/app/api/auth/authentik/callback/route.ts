import { NextResponse, type NextRequest } from "next/server";
import { cookies, headers } from "next/headers";
import {
  exchangeCode,
  getUserInfo,
  oidcEnabled,
  upsertOidcUser,
} from "@/lib/oidc";
import { createSessionToken, SESSION_COOKIE, getSessionCookieOptions } from "@/lib/auth";
import db from "@/lib/db";
import { findResellerByHost } from "@/lib/resellers";
import { buildWelcomeEmail } from "@/lib/mail-templates";
import { OIDC_STATE_COOKIE, OIDC_VERIFIER_COOKIE, OIDC_NEXT_COOKIE } from "@/app/api/auth/authentik/login/route";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!oidcEnabled()) {
    return NextResponse.redirect(new URL("/login", req.nextUrl.origin), 302);
  }

  const store = await cookies();
  const errParam = req.nextUrl.searchParams.get("error");
  if (errParam) {
    // User denied consent or something failed upstream — back to login.
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(errParam)}`, req.nextUrl.origin),
      302,
    );
  }

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const storedState = store.get(OIDC_STATE_COOKIE)?.value;
  const verifier = store.get(OIDC_VERIFIER_COOKIE)?.value;
  const next = store.get(OIDC_NEXT_COOKIE)?.value ?? "/dashboard";
  const origin = req.nextUrl.origin;

  if (!code || !state || !storedState || !verifier || state !== storedState) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent("state_mismatch")}`, origin),
      302,
    );
  }

  // Clean up the one-time auth cookies no matter what happens next.
  store.set(OIDC_STATE_COOKIE, "", { maxAge: 0, path: "/" });
  store.set(OIDC_VERIFIER_COOKIE, "", { maxAge: 0, path: "/" });
  store.set(OIDC_NEXT_COOKIE, "", { maxAge: 0, path: "/" });

  let tokens;
  let info;
  try {
    tokens = await exchangeCode(origin, code, verifier);
    info = await getUserInfo(tokens.access_token);
  } catch (e) {
    console.error("[OIDC] Token/userinfo exchange failed:", e);
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent("exchange_failed")}`, origin),
      302,
    );
  }

  // White-label: link the account to the reseller whose domain the portal is
  // being served from, so the reseller's brand applies to this user.
  const host = req.headers.get("host");
  const reseller = findResellerByHost(host);

  let userId: string;
  try {
    userId = upsertOidcUser(info, reseller?.id ?? null);
  } catch (e) {
    console.error("[OIDC] User upsert failed:", e);
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent("user_provision_failed")}`, origin),
      302,
    );
  }

  // Brand-new account? Send the welcome email (async, non-blocking).
  const created = db
    .prepare("SELECT created_at FROM users WHERE id = ?")
    .get(userId) as { created_at: string } | undefined;
  const isNew =
    created &&
    Date.now() - new Date(created.created_at + "Z").getTime() < 60_000;
  if (isNew && info.email) {
    buildWelcomeEmail({
      name: info.name ?? info.email,
      email: info.email.toLowerCase(),
      plan: "consumer",
    }).catch(() => {});
  }

  const headersList = await headers();
  const res = NextResponse.redirect(
    new URL(next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard", origin),
    302,
  );
  res.cookies.set(
    SESSION_COOKIE,
    createSessionToken(userId),
    getSessionCookieOptions(headersList.get("host")),
  );
  return res;
}