import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";
import fs from "node:fs";
import path from "node:path";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing voicemail ID" }, { status: 400 });
  }

  const vm = db
    .prepare("SELECT * FROM voicemails WHERE id = ? AND user_id = ?")
    .get(id, user.id) as { recording_file?: string | null } | undefined;

  if (!vm) {
    return NextResponse.json({ error: "Voicemail not found" }, { status: 404 });
  }

  if (!vm.recording_file) {
    return NextResponse.json({ error: "No recording available" }, { status: 404 });
  }

  // Mark as listened
  db.prepare("UPDATE voicemails SET listened = 1 WHERE id = ?").run(id);

  try {
    const filePath = path.resolve(vm.recording_file);
    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: "Recording file not found" }, { status: 404 });
    }

    const stat = fs.statSync(filePath);
    const stream = fs.createReadStream(filePath);

    return new NextResponse(stream as unknown as BodyInit, {
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(stat.size),
        "Content-Disposition": `inline; filename="voicemail-${id}.wav"`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json({ error: "Failed to read recording" }, { status: 500 });
  }
}
