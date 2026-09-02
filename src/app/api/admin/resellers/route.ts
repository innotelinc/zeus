import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";
import { getResellers } from "@/lib/resellers";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }
  return NextResponse.json({ resellers: getResellers() });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const { name, brand_name, domain } = (await req.json()) as {
    name?: string;
    brand_name?: string;
    domain?: string;
  };

  if (!name || !name.trim()) {
    return NextResponse.json({ error: "Reseller name required" }, { status: 400 });
  }

  const id = randomUUID();
  db.prepare(
    "INSERT INTO resellers (id, name, brand_name, domain) VALUES (?, ?, ?, ?)",
  ).run(id, name.trim(), brand_name?.trim() || null, domain?.trim() || null);

  return NextResponse.json({ success: true, id });
}

export async function DELETE(req: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id query param required" }, { status: 400 });
  }

  const exists = db.prepare("SELECT id FROM resellers WHERE id = ?").get(id);
  if (!exists) {
    return NextResponse.json({ error: "Reseller not found" }, { status: 404 });
  }

  // Unlink users before removing the reseller.
  db.prepare("UPDATE users SET reseller_id = NULL WHERE reseller_id = ?").run(id);
  db.prepare("DELETE FROM resellers WHERE id = ?").run(id);

  return NextResponse.json({ success: true });
}