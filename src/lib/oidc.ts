import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import db from "./db";

/**
 * Authentik OIDC (authorization-code + PKCE) client.
 *
 * The portal delegates all authentication and user management to Authentik:
 *   - /api/auth/authentik/login    → redirect to Authentik's authorize URL
 *   - /api/auth/authentik/callback → exchange the code, upsert the local user,
 *                                    issue the portal session cookie
 *   - /api/auth/logout             → clear the session, redirect to Authentik's
 *                                    OIDC end-session endpoint
 *
 * Required env vars (all three must be set for SSO to be active):
 *   AUTHENTIK_ISSUER_URL    e.g. https://auth.zeus.innotel.us/application/o/zeus
 *   AUTHENTIK_CLIENT_ID
 *   AUTHENTIK_CLIENT_SECRET
 * Optional:
 *   AUTHENTIK_ADMIN_EMAILS  comma-separated emails granted the admin role
 *   NEXT_PUBLIC_URL         portal origin used for the redirect URI
 */

export function oidcEnabled(): boolean {
  return Boolean(
    process.env.AUTHENTIK_ISSUER_URL &&
      process.env.AUTHENTIK_CLIENT_ID &&
      process.env.AUTHENTIK_CLIENT_SECRET,
  );
}

export function oidcIssuerBase(): string {
  return (process.env.AUTHENTIK_ISSUER_URL ?? "").replace(/\/+$/, "");
}

/** Public redirect URI registered on the Authentik application. */
export function redirectUri(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/auth/authentik/callback`;
}

interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  end_session_endpoint?: string;
  issuer: string;
}

let _discovery: Promise<OidcDiscovery> | null = null;

/** Fetch (and memoize) the OIDC discovery document from Authentik. */
export function discoverOidc(): Promise<OidcDiscovery> {
  if (!_discovery) {
    _discovery = (async () => {
      const url = `${oidcIssuerBase()}/.well-known/openid-configuration`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`OIDC discovery failed (${res.status}) for ${url}`);
      }
      const doc = (await res.json()) as OidcDiscovery;
      if (!doc.authorization_endpoint || !doc.token_endpoint) {
        throw new Error(`OIDC discovery document missing endpoints at ${url}`);
      }
      return doc;
    })();
  }
  return _discovery;
}

/** PKCE challenge pair — verifier goes in an httpOnly cookie, S256 in the URL. */
export function makePkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

export function makeState(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export interface OidcTokens {
  access_token: string;
  id_token: string;
}

/** Exchange the authorization code for tokens using the stored PKCE verifier. */
export async function exchangeCode(
  origin: string,
  code: string,
  verifier: string,
): Promise<OidcTokens> {
  const disc = await discoverOidc();
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(origin),
    client_id: process.env.AUTHENTIK_CLIENT_ID ?? "",
    code_verifier: verifier,
  });
  const res = await fetch(disc.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(
        `${process.env.AUTHENTIK_CLIENT_ID ?? ""}:${process.env.AUTHENTIK_CLIENT_SECRET ?? ""}`,
      ).toString("base64")}`,
    },
    body: params.toString(),
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Token exchange failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  return (await res.json()) as OidcTokens;
}

export interface OidcUserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  given_name?: string;
  family_name?: string;
}

/** Fetch the userinfo document (name/email/subject) for the access token. */
export async function getUserInfo(accessToken: string): Promise<OidcUserInfo> {
  const disc = await discoverOidc();
  const res = await fetch(disc.userinfo_endpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Userinfo request failed (${res.status})`);
  }
  return (await res.json()) as OidcUserInfo;
}

function resolveName(info: OidcUserInfo): string {
  const fullName = [info.given_name, info.family_name].filter(Boolean).join(" ");
  return (
    info.name ||
    info.preferred_username ||
    fullName ||
    (info.email && info.email.split("@")[0]) ||
    info.sub
  );
}

/**
 * Upsert the local user row for an Authentik subject.
 * Matches by auth_subject first, then by email; creates the account when
 * neither exists. New accounts default to the consumer plan; the role comes
 * from AUTHENTIK_ADMIN_EMAILS. Passwords are not stored (Authentik is the
 * identity provider) — password_hash gets an inert "!oidc" marker.
 */
export function upsertOidcUser(
  info: OidcUserInfo,
  resellerId: string | null = null,
): string {
  const email = (info.email ?? "").toLowerCase();
  const name = resolveName(info);

  let existing = db
    .prepare("SELECT id FROM users WHERE auth_subject = ?")
    .get(info.sub) as { id: string } | undefined;

  if (!existing && email) {
    existing = db
      .prepare("SELECT id FROM users WHERE LOWER(email) = LOWER(?)")
      .get(email) as { id: string } | undefined;
  }

  if (existing) {
    db.prepare(
      "UPDATE users SET auth_subject = COALESCE(auth_subject, ?), name = ?, email = CASE WHEN ? <> '' THEN ? ELSE email END, reseller_id = CASE WHEN reseller_id IS NULL THEN ? ELSE reseller_id END, updated_at = datetime('now') WHERE id = ?",
    ).run(info.sub, name, email, email, resellerId, existing.id);
    return existing.id;
  }

  const id = randomUUID();
  const adminEmails = (process.env.AUTHENTIK_ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase());
  const role = email && adminEmails.includes(email) ? "admin" : null;
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, plan, role, auth_subject, reseller_id) VALUES (?, ?, ?, '!oidc', 'consumer', ?, ?, ?)",
  ).run(id, email || null, name, role, info.sub, resellerId);
  return id;
}