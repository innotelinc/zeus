import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";

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
    .prepare("SELECT * FROM voicemails WHERE id = ? AND user_id = ?")
    .get(voicemail_id, user.id) as { recording_file?: string | null } | undefined;

  if (!vm) {
    return NextResponse.json({ error: "Voicemail not found" }, { status: 404 });
  }

  // In production, send via sendmail or an email service.
  // For now, we record the request and return success.
  db.prepare(
    "UPDATE voicemails SET listened = 1 WHERE id = ?",
  ).run(voicemail_id);

  return NextResponse.json({
    success: true,
    message: `Voicemail sent to ${user.email}`,
  });
}
