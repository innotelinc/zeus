/**
 * Scoped service tokens — how a machine client authenticates to the portal API.
 *
 * WHY THIS EXISTS
 * ---------------
 * The fax and number handlers authenticate on the operator's `pbx_session`
 * cookie, and a session belongs to a browser: it expires, it is tied to a user,
 * and there is no way to tell a machine client from a replayed cookie. Genesis
 * (BusinessOps) files an EIN — it posts a signed SS-4 to `POST /api/fax/send` as
 * the responsible party's designee, then polls for the transmission result — and
 * it is not a browser. Its only alternative was to mint a session and forward it
 * forever, which is a credential with no scope, no owner and no audit trail.
 *
 * So a machine client presents `Authorization: Bearer <token>`, and the token is
 * *scoped*: `SERVICE_TOKENS` names the account the token acts as and the exact
 * scopes it carries, and each route asks for the scope it needs. A token that
 * authenticates and does not carry `fax:send` still cannot send a fax — the point
 * is that the estate's mobile/business identity gap closes with least privilege
 * rather than by widening the cookie.
 *
 * CONFIGURATION — `SERVICE_TOKENS`, a JSON array:
 *
 *   [{"name":"genesis",
 *     "token":"<openssl rand -hex 32>",
 *     "email":"businessops@innotel.us",
 *     "scopes":["fax:send","fax:read","numbers:read","numbers:order"]}]
 *
 * `email` must name an existing portal account, because every handler filters its
 * rows by `user_id`: a token acts *as* that account, and it sees exactly what
 * that account sees and nothing more. An email that does not resolve is a 403,
 * not a silent fallback.
 *
 * Unset (or empty) means no service tokens at all — every route falls back to the
 * session, which is the behaviour before this module existed. A token is compared
 * in constant time, and a wrong-length one is rejected before the compare (which
 * would otherwise throw and turn a bad credential into a 500).
 */
import crypto from "crypto";
import db from "./db";
import type { User } from "./types";

export interface ServiceToken {
  /** Who holds it — for logs and error messages, never a credential. */
  name: string;
  /** The secret. Compared, never logged. */
  token: string;
  /** The portal account the token acts as. */
  email: string;
  /** What the token may do. A route asks for one of these. */
  scopes: string[];
}

/** The scopes a route can ask for. Kept here so a typo is a compile error. */
export const SCOPE = {
  faxSend: "fax:send",
  faxRead: "fax:read",
  numbersRead: "numbers:read",
  numbersOrder: "numbers:order",
} as const;

export type Scope = (typeof SCOPE)[keyof typeof SCOPE];

/** The user columns every session lookup returns — one shape for both paths. */
const USER_COLUMNS =
  "id, email, name, phone, plan, plan_status, country, role, " +
  "stripe_subscription_id, created_at, updated_at";

export function serviceTokens(): ServiceToken[] {
  const raw = (process.env.SERVICE_TOKENS ?? "").trim();
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("SERVICE_TOKENS is not valid JSON — no service tokens loaded");
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn("SERVICE_TOKENS must be a JSON array — no service tokens loaded");
    return [];
  }

  return parsed.flatMap((entry): ServiceToken[] => {
    if (!entry || typeof entry !== "object") return [];
    const { name, token, email, scopes } = entry as Record<string, unknown>;
    if (typeof token !== "string" || !token) return [];
    return [
      {
        name: typeof name === "string" && name ? name : "service",
        token,
        email: typeof email === "string" ? email.trim() : "",
        scopes: Array.isArray(scopes)
          ? scopes.filter((s): s is string => typeof s === "string")
          : [],
      },
    ];
  });
}

/** The bearer credential on a request, or `""` when it carries none. */
export function bearerCredential(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ")
    ? header.slice("bearer ".length).trim()
    : "";
}

function matches(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // Length-check first: timingSafeEqual throws on a length mismatch.
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * The token a request presents, or null.
 *
 * Every configured token is compared (no early return) so a valid token later in
 * the list is not faster to find than an invalid one — the list is tiny and this
 * is not a hot path.
 */
export function matchServiceToken(presented: string): ServiceToken | null {
  let found: ServiceToken | null = null;
  for (const candidate of serviceTokens()) {
    if (matches(candidate.token, presented)) found ??= candidate;
  }
  return found;
}

export function serviceAllows(entry: ServiceToken, scope: Scope): boolean {
  return entry.scopes.includes(scope) || entry.scopes.includes("*");
}

/** The portal account a token acts as, or null when it names none. */
export function serviceUser(entry: ServiceToken): User | null {
  if (!entry.email) return null;
  const user = db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE email = ?`)
    .get(entry.email) as User | undefined;
  return user ?? null;
}
