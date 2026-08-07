import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";

export async function PATCH(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { name, email, phone, country } = (await req.json()) as {
    name?: string;
    email?: string;
    phone?: string | null;
    country?: string;
  };

  if (email && email !== user.email) {
    const existing = db
      .prepare("SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ?")
      .get(email, user.id);
    if (existing) {
      return NextResponse.json(
        { error: "Email already in use" },
        { status: 409 },
      );
    }
  }

  db.prepare(
    `UPDATE users SET name = COALESCE(?, name), email = COALESCE(?, email),
     phone = ?, country = COALESCE(?, country), updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    name ?? null,
    email ?? null,
    phone !== undefined ? phone : null,
    country ?? null,
    user.id,
  );

  return NextResponse.json({ success: true });
}
