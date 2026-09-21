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
 * ## The policy is Capstone's policy
 *
 * Capstone gates the *same* SKUs on the *same* Magnate instance
 * (`capstone/scripts/sync_dograh_routes.py`, `capstone/dashboard-backend/app/
 * entitlements.py`), so the two products must not disagree about what an
 * answer means — a disagreement is what left every DID unwired while Capstone
 * believed the numbers were paid for. One vocabulary, in both:
 *
 *   | Magnate / config          | mode           | routing |
 *   |---------------------------|----------------|---------|
 *   | MAGNATE_PUBLIC_URL unset  | `standalone`   | ENABLED |
 *   | URL set, SKU plan unset   | `disabled`     | ENABLED |
 *   | unreachable / bad body    | `open`         | ENABLED |
 *   | entitled: true            | `entitled`     | ENABLED |
 *   | entitled: false, or 404   | `not_entitled` | denied  |
 *   | 401                       | `unauthorized` | withheld|
 *
 * Only an authoritative "no" denies. A deployment with no billing configured
 * — and an entitlements outage — must not un-wire a paying customer's phone
 * lines, which is exactly the failure the old fail-closed rule caused. The
 * `reason` keeps every fail-open decision auditable rather than silent.
 *
 * **Weakening the rule this way is only safe because the SKU is explicit.**
 * With no plan slug there is nothing to check, so the gate is INACTIVE — the
 * product is not granted by a guess, it is simply not gated in this
 * deployment. Set the per-SKU slug (`MAGNATE_AGENTS_PLAN`,
 * `MAGNATE_CAPSTONE_PLAN`) to turn the gate on; that is when a lapsed
 * subscription actually un-wires a line.
 *
 * Two consumers still need two different answers:
 *
 *   * ROUTING denies only on `not_entitled`. `unauthorized` is reported as
 *     indecisive so the caller can withhold the plan entirely (Capstone's
 *     sync aborts on the same condition) instead of publishing a plan that
 *     would un-wire every route on a bad token.
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

/**
 * Env vars holding each SKU's Magnate plan slug, in priority order.
 *
 * `capstone` falls back to `MAGNATE_AGENT_PLAN` because that is the name
 * Capstone itself uses for this exact product on this exact Magnate — one
 * variable set in one `.env` keeps both products gating identically.
 */
const SKU_PLAN_ENV: Record<AddonSku, string[]> = {
  agents: ["MAGNATE_AGENTS_PLAN"],
  capstone: ["MAGNATE_CAPSTONE_PLAN", "MAGNATE_AGENT_PLAN"],
};

/** The Magnate plan slug for a SKU, or "" when this deployment does not gate it. */
export function addonPlanSlug(sku: AddonSku): string {
  for (const name of SKU_PLAN_ENV[sku]) {
    const value = (process.env[name] ?? "").trim();
    if (value) return value;
  }
  return "";
}

/** Capstone's gate vocabulary, used verbatim so the two products read alike. */
export type GateMode =
  | "entitled"
  | "not_entitled"
  | "standalone"
  | "disabled"
  | "open"
  | "unauthorized";

export interface AddonGate {
  sku: AddonSku;
  mode: GateMode;
  reason: string;
  /** The routing answer: false only on an authoritative "no". */
  entitled: boolean;
  /** The gate could not be evaluated (a config error) — withhold, don't deny. */
  indecisive: boolean;
  /** Present when the answer came from Magnate (not standalone/unreachable). */
  decision: MagnateDecision | null;
}

/** Evaluate one SKU's gate. Does not follow `requires` — see `routingGate`. */
export async function addonGate(
  sku: AddonSku,
  opts: { user?: string; phone?: string } = {},
): Promise<AddonGate> {
  const base = { sku, indecisive: false, decision: null } as const;

  // No billing configured anywhere: standalone, nothing to gate on. Capstone
  // treats this as entitled and so must we, or the two disagree on the same
  // host and half the estate stops answering.
  if (!magnateConfigured()) {
    return {
      ...base,
      mode: "standalone",
      reason: "standalone_no_billing",
      entitled: true,
      decision: null,
    };
  }

  // Billing is configured, but this SKU is not wired to a plan: the gate is
  // inactive rather than closed. This is the deployment-wide default until an
  // operator names the SKU, and it is deliberate — see the module docstring.
  const plan = addonPlanSlug(sku);
  if (!plan) {
    return {
      ...base,
      mode: "disabled",
      reason: "plan_not_configured_gate_inactive",
      entitled: true,
      decision: null,
    };
  }

  const decision = await magnateEntitlement(plan, opts);

  if (decision.source === "unauthorized") {
    // A bad/expired token is a configuration error, not a verdict. Never let
    // it read as "not entitled", or rotating a token un-wires the estate.
    return {
      sku,
      mode: "unauthorized",
      reason: "unauthorized",
      entitled: false,
      indecisive: true,
      decision,
    };
  }

  if (decision.source === "unreachable" || decision.source === "invalid") {
    return {
      sku,
      mode: "open",
      reason: decision.reason,
      entitled: true,
      indecisive: true,
      decision,
    };
  }

  if (decision.entitled === true) {
    return { sku, mode: "entitled", reason: decision.reason, entitled: true, indecisive: false, decision };
  }

  return {
    sku,
    mode: "not_entitled",
    reason: decision.reason,
    entitled: false,
    indecisive: false,
    decision,
  };
}

/** The routing decision for one SKU, with `requires` folded in. */
export interface RoutingGate {
  entitled: boolean;
  /** Do not publish a decision — the gate could not be evaluated. */
  indecisive: boolean;
  mode: GateMode;
  reason: string;
}

/**
 * The routing answer: this SKU AND the SKU it requires.
 *
 * Callers that WRITE routing must check `indecisive` first and withhold,
 * rather than publish `entitled: false`, so a Magnate token problem leaves
 * the last good plan in place.
 */
export async function routingGate(
  sku: AddonSku,
  opts: { user?: string; phone?: string } = {},
): Promise<RoutingGate> {
  const gate = await addonGate(sku, opts);
  if (gate.indecisive || gate.mode === "not_entitled") {
    return { entitled: gate.entitled, indecisive: gate.indecisive, mode: gate.mode, reason: gate.reason };
  }

  const required = ADDONS[sku].requires;
  if (required) {
    const parent = await addonGate(required, opts);
    if (parent.indecisive) {
      return { entitled: false, indecisive: true, mode: parent.mode, reason: parent.reason };
    }
    if (parent.mode === "not_entitled") {
      return {
        entitled: false,
        indecisive: false,
        mode: "not_entitled",
        reason: `requires_${required}`,
      };
    }
  }

  return { entitled: true, indecisive: false, mode: gate.mode, reason: gate.reason };
}

/**
 * Boolean routing answer, for callers that only need a yes/no.
 *
 * Denies on an authoritative "no", and also on `unauthorized` — a caller
 * asking a plain boolean cannot withhold, and granting a paid product on an
 * unverifiable config is worse than denying it. Writers that CAN withhold
 * (the routing route) should use `routingGate` instead.
 */
export async function addonEnabled(
  sku: AddonSku,
  opts: { user?: string; phone?: string } = {},
): Promise<boolean> {
  const gate = await routingGate(sku, opts);
  if (gate.indecisive) return false;
  return gate.entitled;
}

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
 * The UI answer, including the honest "couldn't check" case.
 *
 * `standalone`, `disabled` and `open` render as ENABLED so the screen matches
 * what routing actually does; the reason string names which of the three it
 * was, so an operator can still see that nothing was verified.
 */
export async function addonStatus(
  sku: AddonSku,
  opts: { user?: string; phone?: string } = {},
): Promise<AddonStatus> {
  const gate = await addonGate(sku, opts);

  // Only a config error is genuinely neither yes nor no.
  if (gate.indecisive) {
    return { sku, state: "unknown", reason: gate.reason, decision: gate.decision };
  }
  if (gate.mode === "not_entitled") {
    return { sku, state: "disabled", reason: gate.reason, decision: gate.decision };
  }

  const required = ADDONS[sku].requires;
  if (required) {
    const parent = await addonGate(required, opts);
    if (parent.indecisive) {
      return {
        sku,
        state: "unknown",
        reason: `requires_${required}_${parent.reason}`,
        decision: gate.decision,
      };
    }
    if (parent.mode === "not_entitled") {
      return {
        sku,
        state: "disabled",
        reason: `requires_${required}`,
        decision: gate.decision,
      };
    }
  }

  return { sku, state: "enabled", reason: gate.reason, decision: gate.decision };
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
