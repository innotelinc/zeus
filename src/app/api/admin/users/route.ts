import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";
import type { User } from "@/lib/types";

export const dynamic = "force-dynamic";

function requireAdmin(user: User | null): NextResponse | null {
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }
  return null;
}

export async function GET() {
  const user = await getCurrentUser();
  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  const users = db
    .prepare(
      "SELECT id, email, name, phone, plan, plan_status, role, country, created_at, updated_at FROM users ORDER BY created_at DESC",
    )
    .all() as User[];

  const stats = {
    total: users.length,
    business: users.filter((u) => u.plan === "business").length,
    consumer: users.filter((u) => u.plan === "consumer").length,
    admins: users.filter((u) => u.role === "admin").length,
  };

  return NextResponse.json({ users, stats });
}

export async function POST(req: Request) {
  const admin = await getCurrentUser();
  const forbidden = requireAdmin(admin);
  if (forbidden) return forbidden;

  const { email, password, name, plan, role } = (await req.json()) as {
    email?: string;
    password?: string;
    name?: string;
    plan?: string;
    role?: string;
  };

  if (!email || !password) {
    return NextResponse.json({ error: "Email and password required" }, { status: 400 });
  }

  // Check if email already exists
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) {
    return NextResponse.json({ error: "A user with that email already exists" }, { status: 409 });
  }

  const id = randomUUID();
  const hash = bcrypt.hashSync(password, 10);
  const defaultPlan = plan ?? "consumer";

  db.prepare(
    `INSERT INTO users (id, email, password_hash, name, plan, plan_status, role, country, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, 'US', datetime('now'), datetime('now'))`,
  ).run(id, email, hash, name ?? email.split("@")[0], defaultPlan, role ?? null);

  return NextResponse.json({ success: true, userId: id });
}

export async function DELETE(req: Request) {
  const admin = await getCurrentUser();
  const forbidden = requireAdmin(admin);
  if (forbidden) return forbidden;

  const url = new URL(req.url);
  const userId = url.searchParams.get("userId");

  if (!userId) {
    return NextResponse.json({ error: "userId query param required" }, { status: 400 });
  }

  // Don't allow self-deletion
  if (userId === admin!.id) {
    return NextResponse.json(
      { error: "Cannot delete your own account" },
      { status: 400 },
    );
  }

  const existing = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
  if (!existing) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  db.prepare("DELETE FROM users WHERE id = ?").run(userId);

  return NextResponse.json({ success: true });
}

export async function PATCH(req: Request) {
  const admin = await getCurrentUser();
  const forbidden = requireAdmin(admin);
  if (forbidden) return forbidden;

  const { userId, plan, role } = (await req.json()) as {
    userId?: string;
    plan?: string;
    role?: string;
  };

  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  // Don't allow self-demotion
  if (userId === admin!.id && role && role !== "admin") {
    return NextResponse.json(
      { error: "Cannot remove your own admin role" },
      { status: 400 },
    );
  }

  const updates: string[] = [];
  const params: (string | null)[] = [];

  if (plan) {
    updates.push("plan = ?");
    params.push(plan);
  }
  if (role !== undefined) {
    updates.push("role = ?");
    params.push(role);
  }

  if (updates.length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  updates.push("updated_at = datetime('now')");
  params.push(userId);

  db.prepare(
    `UPDATE users SET ${updates.join(", ")} WHERE id = ?`,
  ).run(...params);

  return NextResponse.json({ success: true });
}
