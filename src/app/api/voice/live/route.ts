import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-helpers";
import { avaConfigured, liveStatus } from "@/lib/ava";

export const dynamic = "force-dynamic";

/**
 * GET /api/voice/live
 *
 * Calls in progress right now. Polled by the dashboard's Voice screen; AVA
 * also exposes an SSE stream (/api/system/live-status/stream) which the
 * portal does not proxy yet — polling keeps this route cacheable-free and
 * avoids holding a worker open per open dashboard.
 */
export async function GET() {
  const { error } = await requireUser();
  if (error) return error;

  if (!avaConfigured()) {
    return NextResponse.json({ configured: false, active: [] });
  }

  const result = await liveStatus();
  if (result.state !== "ok") {
    return NextResponse.json(
      { configured: true, error: result.error, ava_state: result.state, active: [] },
      { status: result.state === "unreachable" ? 503 : 502 },
    );
  }

  const active = result.data.sessions ?? result.data.active_calls ?? [];
  return NextResponse.json({
    configured: true,
    ava_state: result.state,
    active,
    count: result.data.count ?? active.length,
  });
}
