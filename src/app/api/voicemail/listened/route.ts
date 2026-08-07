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

  db.prepare(
    "UPDATE voicemails SET listened = 1 WHERE id = ? AND user_id = ?",
  ).run(voicemail_id, user.id);

  return NextResponse.json({ success: true });
}
