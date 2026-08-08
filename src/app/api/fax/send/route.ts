import { NextResponse } from "next/server";
import { requireUser, badRequest } from "@/lib/api-helpers";
import { sendFax } from "@/lib/avantfax";
import db from "@/lib/db";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Fax } from "@/lib/types";

export const dynamic = "force-dynamic";

// 10 MB max
const MAX_FILE_SIZE = 10 * 1024 * 1024;

export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;

  const contentType = req.headers.get("content-type") ?? "";

  if (!contentType.includes("multipart/form-data")) {
    return badRequest("Content-Type must be multipart/form-data");
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return badRequest("Invalid form data");
  }

  const toNumber = (formData.get("to_number") as string)?.trim();
  const fromDidId = (formData.get("from_did_id") as string)?.trim();
  const subject = (formData.get("subject") as string)?.trim() || undefined;
  const body = (formData.get("body") as string)?.trim() || undefined;
  const file = formData.get("file") as File | null;
  const scheduledAt = (formData.get("scheduled_at") as string)?.trim() || undefined;

  // Validate scheduled_at is in the future
  if (scheduledAt) {
    const parsed = new Date(scheduledAt);
    if (isNaN(parsed.getTime())) return badRequest("Invalid schedule date");
    if (parsed <= new Date()) return badRequest("Schedule time must be in the future");
  }

  if (!toNumber) return badRequest("Destination fax number is required");
  if (!fromDidId) return badRequest("Source DID is required");
  if (!file && !body) {
    return badRequest("Provide a PDF file or type a fax body");
  }

  // Validate file
  if (file) {
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      return badRequest("Only PDF files are accepted for faxing");
    }
    if (file.size > MAX_FILE_SIZE) {
      return badRequest("File must be under 10 MB");
    }
  }

  // Get the DID
  const did = db
    .prepare("SELECT * FROM phone_numbers WHERE id = ? AND user_id = ?")
    .get(fromDidId, user.id) as { did: string } | undefined;

  if (!did) return badRequest("Invalid source fax number");

  // Ensure uploads directory exists
  const uploadsDir = join(process.cwd(), "data", "faxes");
  if (!existsSync(uploadsDir)) {
    await mkdir(uploadsDir, { recursive: true });
  }

  const faxId = randomUUID();
  const fileName = `fax_${faxId}.pdf`;
  const filePath = join(uploadsDir, fileName);

  // Save file to disk
  try {
    if (file) {
      const buffer = Buffer.from(await file.arrayBuffer());
      await writeFile(filePath, buffer);
    } else if (body) {
      // Generate a simple PDF from text body
      const pdf = generateTextPdf(body, toNumber, subject);
      await writeFile(filePath, pdf);
    }
  } catch {
    return NextResponse.json(
      { error: "Failed to save fax file" },
      { status: 500 },
    );
  }

  const pages = estimatePages(file?.size ?? Buffer.byteLength(body ?? ""));

  const status = scheduledAt ? "scheduled" : "queued";

  db.prepare(
    `INSERT INTO faxes (id, user_id, direction, status, to_number, subject, pages, file_path, file_type, notes, scheduled_at)
     VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, 'pdf', ?, ?)`,
  ).run(faxId, user.id, status, toNumber, subject ?? null, pages, filePath, body ?? null, scheduledAt ?? null);

  // Queue fax via AvantFax/HylaFAX+ (skip if scheduled)
  let sent = false;
  if (!scheduledAt) {
    try {
      // Read the saved file from disk and send base64 content
      // (portal and freepbx are separate containers — file paths don't cross)
      const pdfBuffer = await readFile(filePath);
      const fileContent = pdfBuffer.toString("base64");

      const result = await sendFax({
        fromDid: did.did,
        toNumber: toNumber,
        fileContent,
        subject: subject ?? undefined,
      });

      if (result.success) {
        db.prepare(
          "UPDATE faxes SET status = 'sent', completed_at = datetime('now') WHERE id = ?",
        ).run(faxId);
        sent = true;
      }
    } catch {
      db.prepare("UPDATE faxes SET status = 'failed' WHERE id = ?").run(faxId);
    }
  }

  const fax = db.prepare("SELECT * FROM faxes WHERE id = ?").get(faxId) as Fax;

  return NextResponse.json({ fax, sent }, { status: 201 });
}

export async function GET(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") ?? "20", 10) || 20, 1), 100);
  const offset = Math.max(parseInt(searchParams.get("offset") ?? "0", 10) || 0, 0);

  const total = (
    db.prepare("SELECT COUNT(*) as count FROM faxes WHERE user_id = ?").get(user.id) as { count: number }
  ).count;

  const faxes = db
    .prepare("SELECT * FROM faxes WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .all(user.id, limit, offset) as Fax[];

  return NextResponse.json({
    faxes,
    total,
    offset,
    limit,
    hasMore: offset + faxes.length < total,
  });
}

// ── Simple text-to-PDF generator (no external deps) ──────────

function generateTextPdf(body: string, toNumber: string, subject?: string): Buffer {
  const title = subject ?? "Fax";
  const date = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  // PDF-safe escaping: single pass for backslash and parentheses
  const esc = (s: string) => s.replace(/[\\()]/g, (m) => "\\" + m);

  // Render multi-line text using Td (move down) + Tj per line
  const lines = body.split("\n");
  const textOps = lines
    .map((line, i) => {
      if (i === 0) return `/F1 11 Tf\n30 685 Td\n(${esc(line)}) Tj`;
      return `0 -15 Td\n(${esc(line)}) Tj`;
    })
    .join("\n");

  const pdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj
4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Courier>>endobj
5 0 obj<</Length 6 0 R>>
stream
BT
/F1 14 Tf
30 750 Td
(${esc(title)}) Tj
/F1 10 Tf
30 730 Td
(To: ${esc(toNumber)}) Tj
30 712 Td
(Date: ${esc(date)}) Tj
${textOps}
ET
endstream
endobj
6 0 obj 0
endobj
xref
0 7
0000000000 65535 f \u0000
0000000009 00000 n \u0000
0000000058 00000 n \u0000
0000000115 00000 n \u0000
0000000266 00000 n \u0000
0000000319 00000 n \u0000
0000000600 00000 n \u0000
trailer<</Size 7/Root 1 0 R>>
startxref
621
%%EOF`;

  // Patch byte offset for stream length
  const streamLen = Buffer.byteLength(
    pdf.substring(pdf.indexOf("stream\n") + 7, pdf.indexOf("\nendstream")),
    "ascii",
  );
  return Buffer.from(pdf.replace("6 0 obj 0", `6 0 obj ${streamLen}`), "ascii");
}

function estimatePages(size: number): number {
  // Rough estimate: ~3,000 bytes per page of Courier text
  return Math.max(1, Math.ceil(size / 3000));
}
