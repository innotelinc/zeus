import { NextResponse } from "next/server";
import { requireUser, notFound } from "@/lib/api-helpers";
import { avaConfigured, getCall, getCallTranscript } from "@/lib/ava";
import { isCapstoneHandoff, toHandoffRow } from "@/lib/handoff";

export const dynamic = "force-dynamic";

/**
 * GET /api/voice/handoffs/[recordId]
 *
 * One hand-off, with what was said. Read from AVA, not reconstructed: this is
 * the record an operator uses when a caller disputes how the call went, so a
 * transcript this portal invented would be worse than none.
 *
 * The hand-off is re-confirmed here rather than trusted from the list request:
 * the caller supplies the id, and an id for an ordinary call must not return
 * its transcript through the hand-off path.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ recordId: string }> },
) {
  const { error } = await requireUser();
  if (error) return error;

  const { recordId } = await params;

  if (!avaConfigured()) {
    return NextResponse.json({ error: "The voice engine is not configured" }, { status: 503 });
  }

  const record = await getCall(recordId);
  if (record.state !== "ok") {
    return NextResponse.json(
      { error: record.error, ava_state: record.state },
      { status: record.state === "unreachable" ? 503 : 502 },
    );
  }

  if (!isCapstoneHandoff(record.data)) {
    return notFound("That call was not handed off to Capstone");
  }

  const transcript = await getCallTranscript(recordId);
  if (transcript.state !== "ok") {
    return NextResponse.json(
      { error: transcript.error, ava_state: transcript.state },
      { status: transcript.state === "unreachable" ? 503 : 502 },
    );
  }

  return NextResponse.json({
    call: toHandoffRow(record.data),
    // What the agent recorded dialling, shown so the operator can see the
    // decision rather than infer it from the transcript.
    transfer_destination: record.data.transfer_destination ?? null,
    turns: transcript.data.turns,
  });
}
