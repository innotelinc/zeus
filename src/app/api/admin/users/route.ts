import { NextResponse } from "next/server";
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
