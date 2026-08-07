import { NextResponse } from "next/server";
import { requireUser, badRequest, notFound } from "@/lib/api-helpers";
import { contactSchema } from "@/lib/validators";
import db from "@/lib/db";
import type { Contact } from "@/lib/types";

export const dynamic = "force-dynamic";

// PATCH /api/contacts/[id] — update a contact
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { user, error } = await requireUser();
  if (error) return error;

  const { id } = await params;
  const existing = db
    .prepare("SELECT * FROM contacts WHERE id = ? AND user_id = ?")
    .get(id, user.id) as Contact | undefined;
  if (!existing) return notFound("Contact not found");

  const body = await req.json().catch(() => ({}));
  const parsed = contactSchema.partial().safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
  }

  const updates = parsed.data;
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) { fields.push("name = ?"); values.push(updates.name); }
  if (updates.phone !== undefined) {
    // Check duplicate
    if (updates.phone !== existing.phone) {
      const dup = db
        .prepare("SELECT id FROM contacts WHERE user_id = ? AND phone = ? AND id != ?")
        .get(user.id, updates.phone, id) as { id: string } | undefined;
      if (dup) {
        return NextResponse.json(
          { error: "A contact with this phone number already exists." },
          { status: 409 },
        );
      }
    }
    fields.push("phone = ?"); values.push(updates.phone);
  }
  if (updates.email !== undefined) { fields.push("email = ?"); values.push(updates.email); }
  if (updates.notes !== undefined) { fields.push("notes = ?"); values.push(updates.notes); }

  if (fields.length > 0) {
    fields.push("updated_at = datetime('now')");
    values.push(id);
    db.prepare(
      `UPDATE contacts SET ${fields.join(", ")} WHERE id = ?`,
    ).run(...values);
  }

  const contact = db
    .prepare("SELECT * FROM contacts WHERE id = ?")
    .get(id) as Contact;

  // Sync conversation names if phone changed
  if (updates.name && existing.phone) {
    db.prepare(
      "UPDATE sms_conversations SET contact_name = ? WHERE user_id = ? AND contact_phone = ?",
    ).run(updates.name, user.id, existing.phone);
  }

  return NextResponse.json({ contact });
}

// DELETE /api/contacts/[id] — delete a contact
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { user, error } = await requireUser();
  if (error) return error;

  const { id } = await params;
  const existing = db
    .prepare("SELECT * FROM contacts WHERE id = ? AND user_id = ?")
    .get(id, user.id) as Contact | undefined;
  if (!existing) return notFound("Contact not found");

  db.prepare("DELETE FROM contacts WHERE id = ?").run(id);

  return NextResponse.json({ success: true });
}
