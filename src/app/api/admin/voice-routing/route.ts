import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";
import { addonStatus } from "@/lib/addons";
import type { User } from "@/lib/types";

export const dynamic = "force-dynamic";

function requireAdmin(user: User | null): NextResponse | null {
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }
  return null;
}

interface AccountRow {
  user_id: string;
  email: string;
  did: string;
  agent_slug: string | null;
  audio_profile: string | null;
  provider: string | null;
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
 * not mark. The check refreshes the account_addons cache in passing; a
 * failure to reach Magnate leaves the account OFF (addonEnabled fails
 * closed), so an outage cannot hand an unpaid account the product.
 */
export async function GET() {
  const user = await getCurrentUser();
  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  const rows = db
    .prepare(
      `SELECT pn.user_id AS user_id,
              u.email   AS email,
              pn.did    AS did,
              va.agent_slug    AS agent_slug,
              va.audio_profile AS audio_profile,
              va.provider      AS provider
         FROM phone_numbers pn
         JOIN users u ON u.id = pn.user_id
         LEFT JOIN voice_agents va ON va.user_id = pn.user_id
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
  // "Not entitled" and "could not check" both leave the hand-off off, but
  // they are different operator problems — a lapsed subscription versus a
  // billing outage — so they are reported separately.
  const unverified: Array<{ did: string; reason: string }> = [];

  for (const row of rows) {
    const status = await addonStatus("capstone", { user: row.email });
    const entitled = status.state === "enabled";

    if (!entitled) unverified.push({ did: row.did, reason: status.reason });

    try {
      cacheStatement.run(row.user_id, "capstone", entitled ? 1 : 0);
    } catch {
      // Best-effort cache; the rendered plan below is the authority.
    }

    accounts.push({
      did: row.did,
      agent: row.agent_slug ?? undefined,
      capstone_addon: entitled,
      provider: row.provider ?? undefined,
      audio_profile: row.audio_profile ?? undefined,
    });
  }

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    accounts,
    capstone_not_enabled: unverified,
  });
}
