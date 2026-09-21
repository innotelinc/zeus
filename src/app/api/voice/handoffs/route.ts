import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-helpers";
import { addonStatus } from "@/lib/addons";
import { avaConfigured, callRecordId, getCall, listCalls, type AvaCall } from "@/lib/ava";
import { isCapstoneHandoff, mightBeHandoff, toHandoffRow } from "@/lib/handoff";

export const dynamic = "force-dynamic";

/** How many recent calls to scan for hand-offs. */
const SCAN_LIMIT = 100;

/**
 * GET /api/voice/handoffs
 *
 * Calls that were actually handed to Capstone's interview agent.
 *
 * Confirming a hand-off needs the full record (`transfer_destination` and the
 * tool calls are not in the list payload), so this scans recent calls and
 * fetches details only for those whose outcome suggests a transfer. The list
 * alone cannot prove a hand-off, and treating "outcome mentions transfer" as
 * proof would show operators calls Capstone never received.
 *
 * Read-only, and returned even when the add-on is off: an account's own call
 * records should not disappear with a subscription. The add-on state rides
 * along so the screen never presents the feature as active.
 */
export async function GET(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;

  const addon = await addonStatus("capstone", { user: user.email });

  if (!avaConfigured()) {
    return NextResponse.json({ configured: false, handoffs: [], scanned: 0, addon });
  }

  const rawLimit = new URL(req.url).searchParams.get("limit");
  const limit = rawLimit ? Number.parseInt(rawLimit, 10) : 25;
  if (!Number.isFinite(limit) || limit < 1 || limit > 200) {
    return NextResponse.json({ error: "limit must be 1-200" }, { status: 400 });
  }

  const list = await listCalls(SCAN_LIMIT);
  if (list.state !== "ok") {
    return NextResponse.json(
      {
        configured: true,
        error: list.error,
        ava_state: list.state,
        handoffs: [],
        scanned: 0,
        addon,
      },
      { status: list.state === "unreachable" ? 503 : 502 },
    );
  }

  const candidates: AvaCall[] = list.data.calls.filter((call) => {
    // include calls whose outcome hints at a transfer, and any call from the
    // interview agent (it is only reachable through a hand-off)
    const agent = (call.agent_slug ?? call.agent ?? "").toLowerCase();
    return mightBeHandoff(call) || agent.includes("capstone") || agent.includes("interview");
  });

  const handoffs = [];
  for (const candidate of candidates.slice(0, limit)) {
    const recordId = callRecordId(candidate);
    if (!recordId) continue;
    const record = await getCall(recordId);
    if (record.state !== "ok") continue;
    if (!isCapstoneHandoff(record.data)) continue;
    handoffs.push(toHandoffRow(record.data));
  }

  return NextResponse.json({
    configured: true,
    ava_state: list.state,
    scanned: list.data.calls.length,
    handoffs,
    addon,
  });
}
