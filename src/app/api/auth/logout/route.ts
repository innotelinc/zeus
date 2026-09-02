import { headers } from "next/headers";
import { SESSION_COOKIE, getSessionCookieOptions } from "@/lib/auth";
import { discoverOidc, oidcEnabled } from "@/lib/oidc";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const headersList = await headers();
  const host = headersList.get("host") ?? "localhost";
  const portalOrigin = `https://${host}`;
  const opts = getSessionCookieOptions(host);

  function expiredSessionResponse(url: URL) {
    const res = NextResponse.redirect(url.toString(), 302);
    res.cookies.set(SESSION_COOKIE, "", { ...opts, maxAge: 0 });
    return res;
  }

  const home = new URL("/", portalOrigin);

  // Also end the Authentik session (single sign-out) when SSO is active.
  if (oidcEnabled()) {
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