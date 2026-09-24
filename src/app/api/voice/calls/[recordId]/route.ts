import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-helpers";
import { avaConfigured, callRecordId, getCall, getCallTranscript, listCalls } from "@/lib/ava";
import { getVoiceCall } from "@/lib/voice-calls";

export const dynamic = "force-dynamic";

/**
 * GET /api/voice/calls/{recordId}
 *
 * One account's AVA call record. The AVA admin API is estate-wide, so the
 * portal's `voice_calls.account_id` join is the authorization boundary before
 * the engine is queried; without it a customer could read another customer's
 * transcript by guessing an id.
 */
export async function GET(
  _req: Request,
  context: { params: Promise<{ recordId: string }> },
) {
  const { user, error } = await requireUser();
  if (error) return error;

  const { recordId } = await context.params;
  const call = getVoiceCall(recordId);
  if (!call || call.account_id !== user.id) {
    return NextResponse.json({ error: "Call not found" }, { status: 404 });
  }

  if (!avaConfigured()) {
    return NextResponse.json(
      { error: "The voice engine is not configured on this deployment" },
      { status: 503 },
    );
  }

  // `voice_calls` is keyed by Asterisk's call id, while AVA's detail endpoint
  // uses its own record id. Resolve the engine id from the account's recent
  // list rather than assuming those two identifiers are interchangeable.
  const listed = await listCalls(500);
  if (listed.state !== "ok") {
    return NextResponse.json(
      { error: listed.error, ava_state: listed.state },
      { status: listed.state === "unreachable" ? 503 : 502 },
    );
  }
  const avaCall = listed.data.calls.find(
    (call) => call.call_id === recordId || callRecordId(call) === recordId,
  );
  if (!avaCall) {
    return NextResponse.json({ error: "Call not found" }, { status: 404 });
  }
  const engineRecordId = callRecordId(avaCall) ?? recordId;

  const [result, transcript] = await Promise.all([
    getCall(engineRecordId),
    getCallTranscript(engineRecordId),
  ]);
  if (result.state !== "ok") {
    return NextResponse.json(
      { error: result.error, ava_state: result.state },
      { status: result.state === "unreachable" ? 503 : 502 },
    );
  }

  return NextResponse.json({
    call: result.data,
    transcript: transcript.state === "ok" ? transcript.data.turns : null,
    record: call,
  });
}
