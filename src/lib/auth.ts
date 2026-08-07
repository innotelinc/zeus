import crypto from "crypto";
import { cookies } from "next/headers";
import db from "./db";
import type { User } from "./types";

let _secret: string | null = null;

function getSecret(): string {
  if (_secret) return _secret;
  const secret = process.env.SESSION_SECRET;
  if (secret) {
    _secret = secret;
    return _secret;
  }
  _secret = crypto.randomBytes(32).toString("base64url");
  console.warn(
    "⚠ SESSION_SECRET not set — auto-generated ephemeral key (sessions reset on restart)",
  );
  return _secret;
}

export const SESSION_COOKIE = "pbx_session";
const TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

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
      "SELECT id, email, name, phone, plan, plan_status, country, created_at, updated_at FROM users WHERE id = ?",
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
