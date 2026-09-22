import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";
import { routingGate } from "@/lib/addons";

export const dynamic = "force-dynamic";

/**
 * Machine-to-machine token for the PBX-side renderer.
 *
 * `pbx/bootstrap-zeus-pbx.sh` (and the `zeus-pbx-sync` timer) fetch this route
 * to get the routing plan, exactly as the docstring below documents. That call
 * is machine-to-machine, so it cannot carry an operator's session cookie:
 * when `PBX_SYNC_TOKEN` is set, the same value in `Authorization: Bearer` is
 * accepted — the convention `/api/agent/transfer-resolve` uses for dograh.
 * Unset (the default) leaves the route admin-session-only.
 */
const SYNC_TOKEN = (process.env.PBX_SYNC_TOKEN ?? "").trim();

function authorizedSync(req: Request): boolean {
  if (!SYNC_TOKEN) return false;
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  return header.slice("Bearer ".length).trim() === SYNC_TOKEN;
}

async function authorized(req: Request): Promise<boolean> {
  if (authorizedSync(req)) return true;
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") return false;
  return true;
}

interface AccountRow {
  user_id: string;
  email: string;
  did: string;
  agent_slug: string | null;
  audio_profile: string | null;
  provider: string | null;
  capstone_binding: string | null;
}

/**
 * GET /api/admin/voice-routing
 *
 * The routing plan the PBX renders from: one entry per active DID, carrying
 * the account's AVA agent and whether its Capstone hand-off is live.
 *
 *   curl -s localhost:3000/api/admin/voice-routing > /tmp/accounts.json
 *   python3 pbx/ava_routing.py --accounts-json /tmp/accounts.json --out /tmp/accounts.conf
 *   python3 pbx/asterisk_converge.py --target <extensions_custom.conf> \
 *       --source /tmp/accounts.conf --owner zeus
 *
 * The Capstone flag is re-checked against Magnate here — this route is the
 * routing authority, and the PBX refuses the hand-off for anything it does
 * not mark. The check refreshes the account_addons cache in passing.
 *
 * `capstone_target` is the other half and comes from `voice_bindings`: the
 * flag says the account may reach Capstone, the binding says WHICH interview
 * workflow its line reaches. It is published only beside a true entitlement —
 * the renderer drops it otherwise, and not sending it keeps the plan's own
 * shape honest rather than relying on a downstream rule to be the only guard.
 *
 * The gate follows Capstone's policy (see `src/lib/addons.ts`): only an
 * authoritative "no" turns the hand-off off, so an unconfigured SKU or a
 * billing outage does not un-wire paying customers' lines. The one case this
 * route will not answer is an INDEcisive gate (a rejected Magnate token):
 * rather than publish a plan that reads as "not entitled" for every account,
 * it returns 503 and publishes nothing, so the PBX keeps its last good
 * fragment. Capstone's sync aborts on the same condition.
 */
export async function GET(req: Request) {
  if (!(await authorized(req))) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const rows = db
    .prepare(
      `SELECT pn.user_id AS user_id,
              u.email   AS email,
              pn.did    AS did,
              va.agent_slug    AS agent_slug,
              va.audio_profile AS audio_profile,
              va.provider      AS provider,
              vb.capstone_binding AS capstone_binding
         FROM phone_numbers pn
         JOIN users u ON u.id = pn.user_id
         LEFT JOIN voice_agents va ON va.user_id = pn.user_id
         LEFT JOIN voice_bindings vb
                ON vb.user_id = pn.user_id AND vb.did = pn.did
        WHERE pn.status = 'active'
        ORDER BY pn.did`,
    )
    .all() as AccountRow[];

  const cacheStatement = db.prepare(
    `INSERT INTO account_addons (user_id, addon, entitled, checked_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, addon)
       DO UPDATE SET entitled = excluded.entitled, checked_at = excluded.checked_at`,
  );

  const accounts = [];
  // "Not entitled" and "could not check" are different operator problems — a
  // lapsed subscription versus a billing config error — so they are reported
  // separately, and only the former is a routing verdict.
  const unverified: Array<{ did: string; reason: string }> = [];
  let gateMode = "entitled";
  let gateReason = "ok";

  for (const row of rows) {
    const gate = await routingGate("capstone", { user: row.email });
    if (gate.indecisive) {
      // Refuse the whole plan: a per-account 0 here would un-wire every line on
      // what may be nothing worse than a stale token.
      return NextResponse.json(
        {
          error: "entitlement_gate_indecisive",
          mode: gate.mode,
          reason: gate.reason,
          did: row.did,
          message:
            "Magnate rejected the entitlements check — refusing to publish a " +
            "routing plan. Fix ENTITLEMENTS_API_TOKEN and retry.",
        },
        { status: 503 },
      );
    }

    gateMode = gate.mode;
    gateReason = gate.reason;
    if (!gate.entitled) unverified.push({ did: row.did, reason: gate.reason });

    try {
      cacheStatement.run(row.user_id, "capstone", gate.entitled ? 1 : 0);
    } catch {
      // Best-effort cache; the rendered plan below is the authority.
    }

    accounts.push({
      did: row.did,
      agent: row.agent_slug ?? undefined,
      capstone_addon: gate.entitled,
      capstone_target: gate.entitled
        ? (row.capstone_binding ?? undefined)
        : undefined,
      provider: row.provider ?? undefined,
      audio_profile: row.audio_profile ?? undefined,
    });
  }

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    gate: { mode: gateMode, reason: gateReason },
    accounts,
    capstone_not_enabled: unverified,
  });
}
