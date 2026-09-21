/**
 * Add-on gating for the voice plane (Zeus side).
 *
 * Zeus sells two voice add-ons, both enforced here and, for routing, again at
 * the PBX:
 *
 *   agents    — AVA answers the account's inbound calls at all (the
 *               first-response voice agent).
 *   capstone  — the account's calls may be handed off to Capstone's interview
 *               agent. Requires `agents`: Capstone is reached *from* an AVA
 *               agent, so it is unreachable without it.
 *
 * Two different consumers need two different answers, and conflating them is
 * how paid features leak:
 *
 *   * ROUTING (dialplan, handoff targets) fails CLOSED. A product is granted
 *     only on an explicit `entitled === true`. `entitled === null` (Magnate
 *     unreachable, or standalone mode with no billing configured) is NOT
 *     granted — a billing outage must not hand an unpaid account the product.
 *     The PBX enforces the same rule independently: [zeus-ai-handoff] refuses
 *     the Capstone destination unless the router stamped
 *     ZEUS_CAPSTONE_ADDON=1, which only pbx/ava_routing.py writes for entitled
 *     accounts.
 *
 *   * UI shows the truth. Hiding a screen behind "no" when the answer is
 *     actually "couldn't tell" trains operators to distrust the dashboard, so
 *     the UI distinguishes disabled from unknown and lets them check.
 */
import { magnateConfigured, magnateEntitlement, type MagnateDecision } from "./magnate";

export type AddonSku = "agents" | "capstone";

export interface AddonDefinition {
  sku: AddonSku;
  label: string;
  description: string;
  /** Add-on that must also be held for this one to be reachable. */
  requires?: AddonSku;
}

export const ADDONS: Record<AddonSku, AddonDefinition> = {
  agents: {
    sku: "agents",
    label: "AI voice agent",
    description:
      "AVA answers inbound calls, runs IVR and business functions, and transfers to your team.",
  },
  capstone: {
    sku: "capstone",
    label: "Capstone interviews",
    description:
      "Hand a call to Capstone's interview agent, which screens the caller and files the transcript.",
    requires: "agents",
  },
};

export type AddonUiState = "enabled" | "disabled" | "unknown";

export interface AddonStatus {
  sku: AddonSku;
  state: AddonUiState;
  reason: string;
  /** Present when the answer came from Magnate (not standalone/unreachable). */
  decision: MagnateDecision | null;
}

/** Add-ons whose SKU string is unknown to this module are refused, not assumed. */
export function isAddonSku(value: string): value is AddonSku {
  return value === "agents" || value === "capstone";
}

/**
 * The routing decision. True only on an explicit entitlement.
 *
 * Standalone deployments (no Magnate configured) are treated as not entitled:
 * there is no billing relationship to grant the product, and the alternative
 * — granting everything when billing is absent — would make a misconfigured
 * deployment give away every paid feature.
 */
export async function addonEnabled(
  sku: AddonSku,
  opts: { user?: string; phone?: string } = {},
): Promise<boolean> {
  if (!magnateConfigured()) return false;

  const decision = await magnateEntitlement(sku, opts);
  if (decision.entitled !== true) return false;

  const required = ADDONS[sku].requires;
  if (required) {
    const parent = await magnateEntitlement(required, opts);
    if (parent.entitled !== true) return false;
  }
  return true;
}

/** The UI answer, including the honest "couldn't check" case. */
export async function addonStatus(
  sku: AddonSku,
  opts: { user?: string; phone?: string } = {},
): Promise<AddonStatus> {
  if (!magnateConfigured()) {
    return {
      sku,
      state: "unknown",
      reason: "standalone_no_billing",
      decision: null,
    };
  }

  const decision = await magnateEntitlement(sku, opts);
  if (decision.entitled === null) {
    // unreachable / unauthorized / invalid — say so rather than showing "off".
    return { sku, state: "unknown", reason: decision.reason, decision };
  }
  if (decision.entitled === false) {
    return { sku, state: "disabled", reason: decision.reason, decision };
  }

  const required = ADDONS[sku].requires;
  if (required) {
    const parent = await magnateEntitlement(required, opts);
    if (parent.entitled !== true) {
      return {
        sku,
        state: "disabled",
        reason: parent.entitled === null ? `requires_${required}_unverified` : `requires_${required}`,
        decision,
      };
    }
  }
  return { sku, state: "enabled", reason: decision.reason, decision };
}

/** Every add-on's status for one account, for the billing/UI surfaces. */
export async function addonStatuses(
  opts: { user?: string; phone?: string } = {},
): Promise<AddonStatus[]> {
  return Promise.all([
    addonStatus("agents", opts),
    addonStatus("capstone", opts),
  ]);
}
