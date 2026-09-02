import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";

export const dynamic = "force-dynamic";

const OLLAMA_URL = (process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.2";

/**
 * POST /api/voicemail/summary
 * Body: { voicemail_id }
 *
 * Summarises the voicemail transcript with a local LLM (Ollama) and stores
 * the result in voicemails.summary. Idempotent — re-runs regenerate the
 * summary. Returns 503 when Ollama is not reachable so the UI can degrade
 * gracefully.
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
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Ollama returned ${res.status}` },
        { status: 502 },
      );
    }
    const data = (await res.json()) as { response?: string };
    summary = (data.response ?? "").trim();
  } catch {
    return NextResponse.json(
      {
        error:
          "AI summaries are unavailable — is Ollama running? Set OLLAMA_URL (default http://127.0.0.1:11434).",
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