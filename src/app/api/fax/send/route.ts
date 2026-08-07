import { NextResponse } from "next/server";
import { requireUser, badRequest } from "@/lib/api-helpers";
import { faxSchema } from "@/lib/validators";
import { sendFax } from "@/lib/avantfax";
import db from "@/lib/db";
import { randomUUID } from "node:crypto";
import type { Fax } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;

  const body = await req.json().catch(() => ({}));
  const parsed = faxSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
  }

  const { to_number, from_did_id, subject, notes } = parsed.data;

  // Get the DID
  const did = db
    .prepare("SELECT * FROM phone_numbers WHERE id = ? AND user_id = ?")
    .get(from_did_id, user.id) as { did: string } | undefined;

  if (!did) {
    return badRequest("Invalid source fax number");
  }

  const faxId = randomUUID();
  db.prepare(
    `INSERT INTO faxes (id, user_id, direction, status, to_number, subject, notes, file_type)
     VALUES (?, ?, 'outbound', 'pending', ?, ?, ?, 'pdf')`,
  ).run(faxId, user.id, to_number, subject ?? null, notes ?? null);

  // Queue fax via AvantFax/HylaFAX+
  try {
    const result = await sendFax({
      fromDid: did.did,
      toNumber: to_number,
      filePath: `fax_${faxId}.pdf`,
      subject: subject ?? undefined,
    });

    if (result.success) {
      db.prepare(
        "UPDATE faxes SET status = 'sent', completed_at = datetime('now') WHERE id = ?",
      ).run(faxId);
    }
  } catch (e) {
    db.prepare("UPDATE faxes SET status = 'failed' WHERE id = ?").run(faxId);
  }

  const fax = db.prepare("SELECT * FROM faxes WHERE id = ?").get(faxId) as Fax;

  return NextResponse.json({ fax }, { status: 201 });
}

export async function GET() {
  const { user, error } = await requireUser();
  if (error) return error;

  const faxes = db
    .prepare(
      "SELECT * FROM faxes WHERE user_id = ? ORDER BY created_at DESC LIMIT 50",
    )
    .all(user.id) as Fax[];

  return NextResponse.json({ faxes });
}
