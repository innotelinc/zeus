import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-helpers";
import { avaConfigured, liveStatus } from "@/lib/ava";
import { activeVoiceCalls } from "@/lib/voice-calls";

export const dynamic = "force-dynamic";

/**
 * GET /api/voice/live
 *
 * Calls in progress right now. Polled by the dashboard's Voice screen; AVA
 * also exposes an SSE stream (/api/system/live-status/stream) which the
 * portal does not proxy yet — polling keeps this route cacheable-free and
 * avoids holding a worker open per open dashboard.
 *
 * Two answers, deliberately: `active` is what the voice engine says it is
 * carrying, and `recorded` is `voice_calls` — the switch's own rows, with the
 * call id, the account, the interview binding and the hand-offs so far (P4).
 * They are not the same question: the engine only knows calls whose media it is
 * handling, while the record exists from the moment the dialplan stamped the
 * channel — including a call the engine has not picked up, or one that has
 * already been handed away from it. The screen shows both because a call that
 * moved AVA → Capstone is absent from the engine's list and is exactly the call
 * an operator wants to see.
 */
export async function GET() {
  const { error } = await requireUser();
  if (error) return error;

  const recorded = activeVoiceCalls();

  if (!avaConfigured()) {
    // The record is the portal's own and survives an unconfigured engine, so
    // this is not an empty answer — it is the answer without the engine half.
    return NextResponse.json({ configured: false, active: [], recorded });
  }

  const result = await liveStatus();
  if (result.state !== "ok") {
    return NextResponse.json(
      {
        configured: true,
        error: result.error,
        ava_state: result.state,
        active: [],
        recorded,
      },
      { status: result.state === "unreachable" ? 503 : 502 },
    );
  }

  const active = result.data.sessions ?? result.data.active_calls ?? [];
  return NextResponse.json({
    configured: true,
    ava_state: result.state,
    active,
    recorded,
    count: result.data.count ?? active.length,
  });
}
