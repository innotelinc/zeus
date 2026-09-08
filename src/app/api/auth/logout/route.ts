import { cookies, headers } from "next/headers";
import { SESSION_COOKIE, getSessionCookieOptions, verifySessionToken } from "@/lib/auth";
import db from "@/lib/db";
import { authMode, discoverOidc, ssoLoginEnabled } from "@/lib/oidc";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const headersList = await headers();
  const reqCookies = await cookies();
  const host = headersList.get("host") ?? "localhost";
  const portalOrigin = `https://${host}`;
  const opts = getSessionCookieOptions(host);

  function expiredSessionResponse(url: URL) {
    const res = NextResponse.redirect(url.toString(), 302);
    res.cookies.set(SESSION_COOKIE, "", { ...opts, maxAge: 0 });
    return res;
  }

  const home = new URL("/", portalOrigin);

  // Also end the Authentik session (single sign-out) when the SSO flow is
  // the offered sign-in path. In "both" mode only Authentik-provisioned
  // accounts (password_hash = '!oidc') get the end-session redirect — a
  // locally-created password account has no Authentik session to end.
  if (ssoLoginEnabled()) {
    if (authMode() === "both") {
      const token = reqCookies.get(SESSION_COOKIE)?.value;
      const userId = token ? verifySessionToken(token) : null;
      const row = userId
        ? (db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as
            { password_hash: string | null } | undefined)
        : undefined;
      if (!row || row.password_hash !== "!oidc") {
        return expiredSessionResponse(home);
      }
    }
    try {
      const disc = await discoverOidc();
      if (disc.end_session_endpoint) {
        const url = new URL(disc.end_session_endpoint);
        url.searchParams.set(
          "post_logout_redirect_uri",
          (process.env.NEXT_PUBLIC_URL ?? portalOrigin).replace(/\/+$/, ""),
        );
        return expiredSessionResponse(url);
      }
    } catch (e) {
      console.warn("[OIDC] Could not reach Authentik end-session endpoint:", e);
    }
  }

  // No SSO — plain portal logout.
  return expiredSessionResponse(home);
}