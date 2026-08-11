import crypto from "crypto";
import { cookies } from "next/headers";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import db from "./db";
import type { User } from "./types";

let _secret: string | null = null;

const SECRET_DIR = join(process.cwd(), "data");
const SECRET_FILE = join(SECRET_DIR, ".session-secret");

function getSecret(): string {
  if (_secret) return _secret;

  // 1. Check env var (highest priority)
  const envSecret = process.env.SESSION_SECRET;
  if (envSecret) {
    _secret = envSecret;
    return _secret;
  }

  // 2. Check persisted file (survives module reloads in dev mode)
  try {
    if (existsSync(SECRET_FILE)) {
      _secret = readFileSync(SECRET_FILE, "utf8").trim();
      if (_secret) return _secret;
    }
  } catch {
    // file doesn't exist or can't be read
  }

  // 3. Generate new secret and persist it
  _secret = crypto.randomBytes(32).toString("base64url");
  try {
    if (!existsSync(SECRET_DIR)) mkdirSync(SECRET_DIR, { recursive: true });
    writeFileSync(SECRET_FILE, _secret, { mode: 0o600 });
  } catch {
    // can't write to disk, but we still have the in-memory secret
  }
  console.warn(
    `⚠ SESSION_SECRET not set — generated persistent key at ${SECRET_FILE}`,
  );
  return _secret;
}

export const SESSION_COOKIE = "pbx_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days
const TTL_MS = SESSION_MAX_AGE * 1000;

/** Detect the best cookie domain from the request Host header. */
function detectDomain(host: string): string | undefined {
  // Strip port if present
  const hostname = host.replace(/:\d+$/, "");

  // Don't set domain for localhost or IP addresses
  if (
    hostname === "localhost" ||
    /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    hostname.startsWith("[")
  ) {
    return undefined;
  }

  // Prepend dot for subdomain portability (e.g. voice.innotel.us → .innotel.us)
  return `.${hostname}`;
}

/** Shared cookie options for session cookies across all routes. */
export function getSessionCookieOptions(host?: string | null): {
  httpOnly: true;
  sameSite: "lax" | "strict" | "none";
  secure: boolean;
  domain?: string;
  path: string;
  maxAge: number;
} {
  const secure = process.env.SESSION_SECURE === "true";
  const sameSiteRaw = (process.env.SESSION_SAMESITE ?? "lax").toLowerCase();
  const sameSite =
    sameSiteRaw === "strict" || sameSiteRaw === "none"
      ? sameSiteRaw
      : "lax";

  const opts: ReturnType<typeof getSessionCookieOptions> = {
    httpOnly: true,
    sameSite,
    secure: secure || sameSite === "none",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  };

  // 1. Explicit SESSION_DOMAIN env var (highest priority)
  const envDomain = process.env.SESSION_DOMAIN?.trim();
  if (envDomain) {
    opts.domain = envDomain.startsWith(".") ? envDomain : `.${envDomain}`;
  } else if (host) {
    // 2. Auto-detect from request Host header
    opts.domain = detectDomain(host);
  }

  return opts;
}

function sign(payload: string): string {
  return crypto
    .createHmac("sha256", getSecret())
    .update(payload)
    .digest("base64url");
}

export function createSessionToken(userId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ userId, exp: Date.now() + TTL_MS }),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string): string | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload);
  const expectedBuf = Buffer.from(expected);
  const actual = Buffer.from(sig);
  if (
    actual.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(actual, expectedBuf)
  ) {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof data.exp === "number" && data.exp < Date.now()) return null;
    return typeof data.userId === "string" ? data.userId : null;
  } catch {
    return null;
  }
}

export async function getSessionUserId(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

export async function getCurrentUser(): Promise<User | null> {
  const userId = await getSessionUserId();
  if (!userId) return null;
  const user = db
    .prepare(
      "SELECT id, email, name, phone, plan, plan_status, country, stripe_subscription_id, created_at, updated_at FROM users WHERE id = ?",
    )
    .get(userId) as User | undefined;
  return user ?? null;
}

// ─── Password reset ───

const RESET_TTL = 1000 * 60 * 15;

export function createPasswordResetToken(userId: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      userId,
      exp: Date.now() + RESET_TTL,
      purpose: "pwd_reset",
    }),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifyResetToken(token: string): string | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload);
  const expectedBuf = Buffer.from(expected);
  const actual = Buffer.from(sig);
  if (
    actual.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(actual, expectedBuf)
  )
    return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (data.purpose !== "pwd_reset") return null;
    if (typeof data.exp === "number" && data.exp < Date.now()) return null;
    return typeof data.userId === "string" ? data.userId : null;
  } catch {
    return null;
  }
}
