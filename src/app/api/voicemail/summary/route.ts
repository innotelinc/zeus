import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";

export const dynamic = "force-dynamic";

// The endpoint is the estate's shared model gateway (OmniRoute) in the
// deployment, reached through its Ollama-compatible surface; a plain Ollama is
// the fallback for a single-box install.
const SUMMARY_URL = (
  process.env.VOICEMAIL_SUMMARY_URL ??
  process.env.OLLAMA_URL ??
  "http://127.0.0.1:11434"
).replace(/\/+$/, "");

// The *pin* is deliberately its own (VOICEMAIL_SUMMARY_MODEL), not the shared
// OLLAMA_MODEL the voicemail path falls back to: the gateway's free routes
// cooldown per model, so
// a summary that rides the call path's model goes silent the moment calls
// exhaust it — and a busy voicemail box would starve the phone. Two pins make
// the two consumers independent; OLLAMA_MODEL stays the fallback so a
// single-Ollama install keeps working unchanged. The pin is asserted against
// the gateway's live catalogue by `pbx/d7_assert.py` (D7's third claim).
const SUMMARY_MODEL =
  process.env.VOICEMAIL_SUMMARY_MODEL ?? process.env.OLLAMA_MODEL ?? "llama3.2";

/**
 * POST /api/voicemail/summary
 * Body: { voicemail_id }
 *
 * Summarises the voicemail transcript with the pinned summary model (the
 * estate gateway, or Ollama on a single-box install) and stores the result in
 * voicemails.summary. Idempotent — re-runs regenerate the summary. Returns 503
 * when the endpoint is not reachable so the UI can degrade gracefully.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { voicemail_id } = (await req.json()) as { voicemail_id?: string };
  if (!voicemail_id) {
    return NextResponse.json({ error: "Missing voicemail_id" }, { status: 400 });
  }

  const vm = db
    .prepare(
      "SELECT id, transcript FROM voicemails WHERE id = ? AND user_id = ?",
    )
    .get(voicemail_id, user.id) as { id: string; transcript: string | null } | undefined;

  if (!vm) {
    return NextResponse.json({ error: "Voicemail not found" }, { status: 404 });
  }
  if (!vm.transcript || !vm.transcript.trim()) {
    return NextResponse.json(
      { error: "This voicemail has no transcript to summarise." },
      { status: 400 },
    );
  }

  const prompt =
    "You are a voicemail assistant. Summarise the following voicemail transcription " +
    "in 1-3 concise sentences: who called, why, and any requested call-back " +
    "number or action. Plain text only, no preamble.\n\nTranscript:\n" +
    vm.transcript.slice(0, 4000);

  let summary: string;
  try {
    const res = await fetch(`${SUMMARY_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: SUMMARY_MODEL, prompt, stream: false }),
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `the summary model endpoint returned ${res.status}` },
        { status: 502 },
      );
    }
    const data = (await res.json()) as { response?: string };
    summary = (data.response ?? "").trim();
  } catch {
    return NextResponse.json(
      {
        error:
          "AI summaries are unavailable — is the model endpoint running? Set " +
          "VOICEMAIL_SUMMARY_URL (falls back to OLLAMA_URL, then http://127.0.0.1:11434).",
      },
      { status: 503 },
    );
  }

  if (!summary) {
    return NextResponse.json({ error: "Empty summary from model." }, { status: 502 });
  }

  db.prepare(
    "UPDATE voicemails SET summary = ? WHERE id = ? AND user_id = ?",
  ).run(summary, voicemail_id, user.id);

  return NextResponse.json({ success: true, summary });
}