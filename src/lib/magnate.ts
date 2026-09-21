/**
 * Zeus → Magnate (Billing Platform) entitlement client.
 *
 * Magnate owns billing/entitlements for the whole platform. Zeus consumes
 * decisions for add-on SKUs (e.g. the AI-agents add-on) instead of holding
 * Stripe keys: the AI-agents add-on sold from the Zeus billing page unlocks
 * Capstone dograh agent routing, which Capstone verifies itself against the
 * same entitlements API before writing inbound routes.
 *
 * Failure vocabulary mirrors Capstone's `dashboard-backend/app/entitlements.py`
 * exactly, because both products gate the same SKUs on the same Magnate:
 *
 *   404 plan_not_found  → entitled FALSE. An authoritative "no" — Magnate is
 *                         reachable and does not know this plan.
 *   401                 → entitled NULL, source "unauthorized". A config error.
 *                         Neither yes nor no: the caller must not read it as
 *                         "not entitled", or a bad token would silently
 *                         un-wire every route.
 *   anything else bad   → entitled NULL. Not an authoritative "no" either.
 *
 * Env:
 *   MAGNATE_PUBLIC_URL      — shared Magnate storefront (billing portal).
 *                             Empty → standalone mode, no entitlement checks.
 *   ENTITLEMENTS_API_TOKEN  — optional bearer token matching Magnate's
 *                             ENTITLEMENTS_API_TOKEN (empty when unset).
 */
import { z } from "zod";

const MAGNATE_BASE =
  (process.env.MAGNATE_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");

const TOKEN = process.env.ENTITLEMENTS_API_TOKEN ?? "";

export function magnateConfigured(): boolean {
  return MAGNATE_BASE.length > 0;
}

const decisionSchema = z.object({
  entitled: z.boolean().nullable(),
  reason: z.string().optional(),
  plan: z.string().nullable().optional(),
  slug: z.string().nullable().optional(),
  user: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  expires_at: z.number().nullable().optional(),
});

export type MagnateDecision = {
  entitled: boolean | null;
  reason: string;
  plan: string | null;
  slug: string | null;
  user: string | null;
  phone: string | null;
  status: string | null;
  expiresAt: number | null;
  source: "magnate" | "standalone" | "unreachable" | "unauthorized" | "invalid";
};

/**
 * Ask Magnate whether a plan SKU is entitled. Pass `user` (username or email)
 * to require an active subscription owned by that identity; omit it for a
 * plan-level check. Failure policy mirrors Capstone's: unreachable → the
 * caller decides (surfaced as source "unreachable", never silently denied).
 */
export async function magnateEntitlement(
  plan: string,
  opts: { user?: string; phone?: string } = {},
): Promise<MagnateDecision> {
  if (!magnateConfigured()) {
    return {
      entitled: null,
      reason: "standalone_no_magnate",
      plan: null,
      slug: plan,
      user: opts.user ?? null,
      phone: opts.phone ?? null,
      status: null,
      expiresAt: null,
      source: "standalone",
    };
  }

  const params = new URLSearchParams({ plan });
  if (opts.user) params.set("user", opts.user);
  if (opts.phone) params.set("phone", opts.phone);

  let resp: Response;
  try {
    resp = await fetch(`${MAGNATE_BASE}/api/entitlements?${params.toString()}`, {
      headers: {
        Accept: "application/json",
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return {
      entitled: null,
      reason: "unreachable",
      plan: null,
      slug: plan,
      user: opts.user ?? null,
      phone: opts.phone ?? null,
      status: null,
      expiresAt: null,
      source: "unreachable",
    };
  }

  if (resp.status === 401) {
    return {
      entitled: null,
      reason: "unauthorized",
      plan: null,
      slug: plan,
      user: opts.user ?? null,
      phone: opts.phone ?? null,
      status: null,
      expiresAt: null,
      source: "unauthorized",
    };
  }

  // 404 plan_not_found is Magnate answering — and the answer is "no such plan".
  // Same treatment as Capstone's client; read before the JSON shape check,
  // because a 404 body carries `reason` but no `entitled` field.
  if (resp.status === 404) {
    let reason = "plan_not_found";
    try {
      const body = (await resp.json()) as { reason?: unknown };
      if (typeof body?.reason === "string" && body.reason) reason = body.reason;
    } catch {
      // Body was not JSON; the status alone is the answer.
    }
    return {
      entitled: false,
      reason,
      plan: null,
      slug: plan,
      user: opts.user ?? null,
      phone: opts.phone ?? null,
      status: null,
      expiresAt: null,
      source: "magnate",
    };
  }

  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    return {
      entitled: null,
      reason: `bad_response_${resp.status}`,
      plan: null,
      slug: plan,
      user: opts.user ?? null,
      phone: opts.phone ?? null,
      status: null,
      expiresAt: null,
      source: "invalid",
    };
  }
  const parsed = decisionSchema.safeParse(data);
  if (!parsed.success) {
    return {
      entitled: null,
      reason: "bad_response",
      plan: null,
      slug: plan,
      user: opts.user ?? null,
      phone: opts.phone ?? null,
      status: null,
      expiresAt: null,
      source: "invalid",
    };
  }

  const d = parsed.data;
  return {
    entitled: d.entitled,
    reason: d.reason ?? "ok",
    plan: d.plan ?? null,
    slug: d.slug ?? plan,
    user: d.user ?? null,
    phone: d.phone ?? null,
    status: d.status ?? null,
    expiresAt: d.expires_at ?? null,
    source: "magnate",
  };
}
