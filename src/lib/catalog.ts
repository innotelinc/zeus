import db from "./db";

/**
 * What a visitor can subscribe to, in one place, for the marketing page and the
 * subscription page.
 *
 * Two halves, because billing is split by design:
 *
 *  * the **phone plan** lives in this portal's own `plans` table (this portal
 *    is what provisions the number, extension and softphone), and
 *  * the **Capstone voice-agents add-on** is billed by Magnate — the single
 *    billing platform for the ecosystem — under the plan slug `agents`.
 *
 * The prices below are display values. The number that actually charges a card
 * is Magnate's, so keep the two in step when either changes; the defaults match
 * Magnate's `agents` plan ($49/mo, $490/yr) at the time of writing.
 */

const DEFAULT_PHONE_CENTS = 1999;
const AGENTS_MONTHLY_CENTS = Number(process.env.VOICE_AGENTS_MONTHLY_CENTS ?? 4900);
const AGENTS_YEARLY_CENTS = Number(process.env.VOICE_AGENTS_YEARLY_CENTS ?? 49000);

/** Magnate (the ecosystem's billing platform) — shared with lib/magnate.ts. */
const MAGNATE_URL = (process.env.MAGNATE_PUBLIC_URL || "https://app.magnate.innotel.us").replace(/\/+$/, "");

export interface ServicePlan {
  id: string;
  name: string;
  tagline: string;
  priceMonthly: string;
  priceYearly?: string;
  features: string[];
  badge?: string;
  cta: { label: string; href: string; external?: boolean };
}

export interface SubscribeCatalog {
  phone: ServicePlan;
  agents: ServicePlan;
}

/** `19.99` for 1999 — trim the pointless `.00`. */
function money(cents: number): string {
  return (cents / 100).toFixed(2).replace(/\.00$/, "");
}

/** Origins that are portal aliases, never part of the subscribe name. */
const PORTAL_ALIAS = /^(www|app|portal|dashboard)\./;

/**
 * The canonical subscription origin for the host a request arrived on.
 *
 * The pricing page has exactly one home — `subscribe.<domain>` — and the
 * marketing page links to it, so a buyer never sees two different URLs for the
 * same page (and never a `/subscribe` path on the portal origin). Derived from
 * the request host rather than an env var so every branded/reseller domain gets
 * its own subscribe subdomain for free.
 */
export function subscribeOrigin(host: string | null | undefined): string {
  const bare = (host ?? "").toLowerCase().split(":")[0].replace(PORTAL_ALIAS, "");
  if (bare.startsWith("subscribe.")) return `https://${bare}`;
  if (!bare || bare === "localhost" || /^\d+(\.\d+){3}$/.test(bare)) {
    return (process.env.NEXT_PUBLIC_SUBSCRIBE_URL ?? "https://subscribe.zeus.innotel.us").replace(/\/+$/, "");
  }
  return `https://subscribe.${bare}`;
}

/** The phone plan's price from this portal's plans table, for display. */
export function phonePlanCents(): number {
  try {
    const row = db
      .prepare("SELECT amount FROM plans WHERE id = 'consumer'")
      .get() as { amount?: number } | undefined;
    if (row?.amount && row.amount > 0) return row.amount;
  } catch {
    // No DB yet (first boot, migrations pending) — fall back to the default so
    // the marketing page still renders a price instead of failing the route.
  }
  return DEFAULT_PHONE_CENTS;
}

export function subscribeCatalog(): SubscribeCatalog {
  const phoneCents = phonePlanCents();
  return {
    phone: {
      id: "consumer",
      name: "Phone",
      tagline: "Everything you need to talk, text and fax",
      priceMonthly: money(phoneCents),
      features: [
        "Your own phone number",
        "Softphone extension for every device",
        "SMS messaging",
        "Voicemail with transcription & AI summaries",
        "Fax (send and receive)",
      ],
      cta: { label: "Get Phone", href: "/signup" },
    },
    agents: {
      id: "agents",
      name: "AI voice agents",
      tagline: "Capstone agents that answer your calls",
      priceMonthly: money(AGENTS_MONTHLY_CENTS),
      priceYearly: money(AGENTS_YEARLY_CENTS),
      badge: "Add-on",
      features: [
        "Agents answer on your own numbers",
        "Call routing, transfers and message taking",
        "Transcriptions and call summaries",
        "Billed monthly with your phone plan — one bill",
      ],
      cta: {
        label: "Add voice agents",
        href: `${MAGNATE_URL}/signup?plan=agents`,
        external: true,
      },
    },
  };
}
