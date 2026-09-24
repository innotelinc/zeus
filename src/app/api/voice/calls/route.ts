import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-helpers";
import { addonStatus } from "@/lib/addons";
import { SPAN_KIND, withSpan, type Span } from "@/lib/otel";
import { avaConfigured, listCalls } from "@/lib/ava";
import { voiceCallsByCallId } from "@/lib/voice-calls";

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
 *
 * Each call carries its `record` — the portal's own `voice_calls` row, joined on
 * the id both sides already carry (P4). That join is the point of the screen: a
 * call AVA answered, handed to Capstone and returned is one row here, with the
 * path and the account on it, instead of three logs and a question about which
 * product answered.
 */
export async function GET(req: Request) {
  return withSpan("voice.calls.list", (span) => listCallsFor(req, span), {
    kind: SPAN_KIND.SERVER,
    attributes: { "http.route": "/api/voice/calls", "http.method": "GET" },
  });
}

async function listCallsFor(req: Request, span: Span): Promise<Response> {
  const { user, error } = await requireUser();
  if (error) return error;

  const raw = new URL(req.url).searchParams.get("limit");
  const parsedLimit = raw ? Number.parseInt(raw, 10) : 50;
  if (raw && (!Number.isFinite(parsedLimit) || parsedLimit < 1 || parsedLimit > 500)) {
    return NextResponse.json({ error: "limit must be 1-500" }, { status: 400 });
  }

  if (!avaConfigured()) {
    // Not an error — a portal-only install has no engine to read — but the
    // span must say so, or "empty" and "unconfigured" look the same in a trace
    // the way they must not look the same in the dashboard.
    span.setAttribute("zeus.ava.state", "not_configured");
    return NextResponse.json({ configured: false, calls: [], total: null });
  }

  const result = await listCalls(parsedLimit);
  const addon = await addonStatus("agents", { user: user.email });
  span.setAttribute("zeus.ava.state", result.state);

  if (result.state !== "ok") {
    span.setStatus("error", result.error);
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

  const records = voiceCallsByCallId(
    result.data.calls.map((call) => call.call_id ?? ""),
  );
  const calls = result.data.calls.filter((call) => {
    const record = records.get(call.call_id ?? "");
    return record?.account_id === user.id;
  });
  span.setAttribute("zeus.calls.count", calls.length);

  return NextResponse.json({
    configured: true,
    ava_state: result.state,
    calls: calls.map((call) => ({
      ...call,
      record: records.get(call.call_id ?? "") ?? null,
    })),
    // AVA's total is estate-wide; the portal must report the account's view.
    total: calls.length,
    addon,
  });
}
