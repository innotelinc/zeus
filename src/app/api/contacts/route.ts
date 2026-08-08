import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireUser, badRequest } from "@/lib/api-helpers";
import { contactSchema } from "@/lib/validators";
import db from "@/lib/db";
import type { Contact } from "@/lib/types";

export const dynamic = "force-dynamic";

// GET /api/contacts — list all contacts for the current user
export async function GET() {
  const { user, error } = await requireUser();
  if (error) return error;

  const contacts = db
    .prepare(
      "SELECT * FROM contacts WHERE user_id = ? ORDER BY name COLLATE NOCASE ASC",
    )
    .all(user.id) as Contact[];

  return NextResponse.json({ contacts });
}

// POST /api/contacts — create a new contact
export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;

  const body = await req.json().catch(() => ({}));
  const parsed = contactSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
  }

  const { name, phone, email, notes } = parsed.data;

  // Check for duplicate phone
  const existing = db
    .prepare("SELECT id FROM contacts WHERE user_id = ? AND phone = ?")
    .get(user.id, phone) as { id: string } | undefined;
  if (existing) {
    return NextResponse.json(
      { error: "A contact with this phone number already exists." },
      { status: 409 },
    );
  }

  const id = randomUUID();
  db.prepare(
    "INSERT INTO contacts (id, user_id, name, phone, email, notes) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, user.id, name, phone, email ?? null, notes ?? null);

  const contact = db
    .prepare("SELECT * FROM contacts WHERE id = ?")
    .get(id) as Contact;

  // Update any existing conversations that match this phone number
  db.prepare(
    "UPDATE sms_conversations SET contact_name = ? WHERE user_id = ? AND contact_phone = ?",
  ).run(name, user.id, phone);

  return NextResponse.json({ contact }, { status: 201 });
}
