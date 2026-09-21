import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-helpers";
import { addonStatus } from "@/lib/addons";
import { avaConfigured, listCalls } from "@/lib/ava";

export const dynamic = "force-dynamic";

/**
 * GET /api/voice/calls?limit=50
 *
 * Calls AVA answered, with transcripts and recordings behind
 * /api/voice/calls/[recordId].
 *
 * The list is AVA's, not the PBX's: AVA is the first-response app, so its
 * record explains what the caller was asked and what the agent decided,
 * which CDRs do not carry. Read-only, so a disabled add-on still returns the
 * history — removing the data when a subscription lapses would destroy the
 * account's own call records.
 */
export async function GET(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;

  const raw = new URL(req.url).searchParams.get("limit");
  const parsedLimit = raw ? Number.parseInt(raw, 10) : 50;
  if (raw && (!Number.isFinite(parsedLimit) || parsedLimit < 1 || parsedLimit > 500)) {
    return NextResponse.json({ error: "limit must be 1-500" }, { status: 400 });
  }

  if (!avaConfigured()) {
    return NextResponse.json({ configured: false, calls: [], total: null });
  }

  const result = await listCalls(parsedLimit);
  const addon = await addonStatus("agents", { user: user.email });

  if (result.state !== "ok") {
    return NextResponse.json(
      {
        configured: true,
        error: result.error,
        ava_state: result.state,
        calls: [],
        total: null,
        addon,
      },
      { status: result.state === "unreachable" ? 503 : 502 },
    );
  }

  return NextResponse.json({
    configured: true,
    ava_state: result.state,
    calls: result.data.calls,
    total: result.data.total,
    addon,
  });
}
