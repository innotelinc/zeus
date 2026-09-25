import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-helpers";
import { activeVoiceCalls } from "@/lib/voice-calls";
import { dograhConfigured, getHealth } from "@/lib/dograh";

export const dynamic = "force-dynamic";

/**
 * GET /api/voice/live
 *
 * Calls in progress right now, answered from the switch's own store.
 *
 * There used to be two lists here — the engine's sessions and `voice_calls` —
 * because they answered different questions: the engine only knew calls whose
 * media it was carrying, while `voice_calls` existed from the moment the
 * dialplan stamped the channel. With one engine the distinction stops paying
 * for itself. A live row may briefly outlive its call (an AMI reconnect is the
 * usual reason), which is why the screen shows `started_at` beside it: a
 * "live" call from two hours ago is a fact about the AMI connection, and hiding
 * it would make the screen lie about now.
 *
 * The engine is still consulted, but only for reachability — an operator
 * staring at an empty list needs to know whether that is quiet or broken.
 */
export async function GET() {
  const { error } = await requireUser();
  if (error) return error;

  const recorded = activeVoiceCalls();

  if (!dograhConfigured()) {
    return NextResponse.json({
      configured: false,
      active: [],
      recorded,
      error: "the voice engine is not configured on this deployment",
      engine: "not_configured",
    });
  }

  const health = await getHealth();
  return NextResponse.json({
    configured: true,
    engine: health.state === "ok" ? "ok" : health.state,
    // Named as an error because it is one: calls are not being answered. The
    // record still ships, because that half is the portal's own and it is
    // precisely when the engine is down that an operator wants it.
    error: health.state === "ok" ? null : health.error,
    version: health.state === "ok" ? health.data.version : null,
    active: [],
    recorded,
  });
}
