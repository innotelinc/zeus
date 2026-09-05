/**
 * Zeus → Magnate (Billing Platform) entitlement client.
 *
 * Magnate owns billing/entitlements for the whole platform. Zeus consumes
 * decisions for add-on SKUs (e.g. the AI-agents add-on) instead of holding
 * Stripe keys: the AI-agents add-on sold from the Zeus billing page unlocks
 * Capstone dograh agent routing, which Capstone verifies itself against the
 * same entitlements API before writing inbound routes.
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
