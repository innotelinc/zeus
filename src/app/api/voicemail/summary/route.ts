import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";
import { generateVoicemailSummary, summaryConfig } from "@/lib/voicemail-summary";

export const dynamic = "force-dynamic";

/** Summarise an owned voicemail transcript through the shared model gateway. */
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
    .prepare("SELECT id, transcript FROM voicemails WHERE id = ? AND user_id = ?")
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

  const config = summaryConfig();
  if (!config.model || !config.apiKey || config.apiKey.startsWith("vault://")) {
    return NextResponse.json(
      { error: "AI summaries are not configured — set VOICEMAIL_SUMMARY_MODEL and resolve OMNIROUTE_API_KEY from Cerulean Vault." },
      { status: 503 },
    );
  }

  let summary: string;
  try {
    summary = await generateVoicemailSummary(vm.transcript, config);
  } catch (error) {
    // Only our fixed gateway-status messages are returned, never provider bodies
    // or credentials. Transport errors degrade to an availability response.
    if (error instanceof Error && error.message.startsWith("Summary gateway returned")) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    return NextResponse.json(
      { error: "AI summaries are unavailable — check the shared gateway and VOICEMAIL_SUMMARY_URL." },
      { status: 503 },
    );
  }

  db.prepare("UPDATE voicemails SET summary = ? WHERE id = ? AND user_id = ?")
    .run(summary, voicemail_id, user.id);
  return NextResponse.json({ success: true, summary });
}
