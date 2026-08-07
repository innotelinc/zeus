import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";
import { sendEmail, isEmailConfigured } from "@/lib/mail";
import fs from "node:fs";
import path from "node:path";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { voicemail_id } = (await req.json()) as { voicemail_id?: string };
  if (!voicemail_id) {
    return NextResponse.json({ error: "Missing voicemail_id" }, { status: 400 });
  }

  interface VmRow {
    id: string;
    extension_id: string | null;
    caller_id: string | null;
    caller_name: string | null;
    duration_seconds: number;
    transcript: string | null;
    file_path: string | null;
    created_at: string;
  }

  const vm = db
    .prepare(
      "SELECT id, extension_id, caller_id, caller_name, duration_seconds, transcript, file_path, created_at FROM voicemails WHERE id = ? AND user_id = ?",
    )
    .get(voicemail_id, user.id) as VmRow | undefined;

  if (!vm) {
    return NextResponse.json({ error: "Voicemail not found" }, { status: 404 });
  }

  const callerName = vm.caller_name ?? vm.caller_id ?? "Unknown caller";
  const extLabel = vm.extension_id ? ` (Ext ${vm.extension_id})` : "";
  const caller = callerName + extLabel;
  const mins = Math.floor(vm.duration_seconds / 60);
  const secs = vm.duration_seconds % 60;
  const duration = mins + ":" + String(secs).padStart(2, "0");
  const transcript = vm.transcript;
  const recordingFile = vm.file_path;

  const createdAt = vm.created_at ? new Date(vm.created_at) : new Date();
  const dateStr = createdAt.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  // Build plain-text body
  const lines = [
    "Innotel Voicemail",
    "────────────────",
    "Caller: " + caller,
    "Duration: " + duration,
    "Date: " + dateStr,
    "",
  ];
  if (transcript) {
    lines.push("Transcript:");
    lines.push(transcript);
  }
  lines.push("");
  lines.push("Manage your voicemail: https://pbx.innotel.us/dashboard/voicemail");
  const text = lines.join("\n");

  // Build HTML body
  const htmlLines = [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#0a0a12;color:#f4f4f8;border-radius:12px">',
    '<h2 style="margin:0 0 16px;color:#a5a1ff">📞 Innotel Voicemail</h2>',
    '<table style="width:100%;border-collapse:collapse">',
    '<tr><td style="padding:8px 0;color:#ffffff55">Caller</td><td style="color:#f4f4f8;font-weight:600">' + caller + '</td></tr>',
    '<tr><td style="padding:8px 0;color:#ffffff55">Duration</td><td style="color:#f4f4f8">' + duration + '</td></tr>',
    '<tr><td style="padding:8px 0;color:#ffffff55">Date</td><td style="color:#f4f4f8">' + dateStr + '</td></tr>',
    '</table>',
  ];
  if (transcript) {
    htmlLines.push(
      '<div style="margin-top:16px;padding:16px;background:#ffffff08;border-left:3px solid #635bff;border-radius:0 8px 8px 0">',
      '<p style="margin:0;color:#ffffff80;font-style:italic">&ldquo;' + transcript.replace(/"/g, "&quot;") + '&rdquo;</p>',
      '</div>',
    );
  }
  htmlLines.push(
    '<p style="margin-top:24px;text-align:center">',
    '<a href="https://pbx.innotel.us/dashboard/voicemail" style="display:inline-block;padding:10px 24px;background:#635bff;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Manage Voicemail</a>',
    '</p>',
    '</div>',
  );
  const html = htmlLines.join("\n");

  // Attach audio file if available
  const attachments: Array<{ filename: string; path?: string; content?: Buffer; contentType?: string }> = [];

  if (recordingFile) {
    try {
      const resolved = path.resolve(recordingFile);
      if (fs.existsSync(resolved)) {
        const safeCaller = callerName.replace(/\s+/g, "-");
        const safeDate = dateStr.replace(/[,\s]+/g, "-");
        attachments.push({
          filename: "voicemail-" + safeCaller + "-" + safeDate + ".wav",
          path: resolved,
          contentType: "audio/wav",
        });
      }
    } catch {
      // File not accessible — skip attachment
    }
  }

  // Send the email
  const result = await sendEmail({
    to: user.email,
    subject: "Voicemail from " + caller + " — " + duration,
    text,
    html,
    attachments,
  });

  // Mark as listened
  db.prepare("UPDATE voicemails SET listened = 1 WHERE id = ?").run(voicemail_id);

  if (!result.sent) {
    if (!isEmailConfigured()) {
      return NextResponse.json({
        success: true,
        note: "email_not_configured",
        message: "Voicemail recorded. Email transport not configured — set SMTP_HOST to enable forwarding.",
      });
    }
    return NextResponse.json({
      success: false,
      error: result.error ?? "Failed to send email",
    });
  }

  return NextResponse.json({
    success: true,
    message: "Voicemail sent to " + user.email,
  });
}
