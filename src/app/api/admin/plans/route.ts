import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";
import { getPlans, syncStripePrice, type Plan } from "@/lib/plans";
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

  return NextResponse.json({ plans: getPlans() });
}

export async function PATCH(req: Request) {
  const admin = await getCurrentUser();
  const forbidden = requireAdmin(admin);
  if (forbidden) return forbidden;

  const body = (await req.json()) as {
    id: string;
    name?: string;
    amount?: number; // in cents
    currency?: string;
    interval?: string;
    max_numbers?: number;
    syncStripe?: boolean;
  };

  if (!body.id) {
    return NextResponse.json({ error: "Plan ID required" }, { status: 400 });
  }

  const plan = db
    .prepare("SELECT * FROM plans WHERE id = ?")
    .get(body.id) as Plan | undefined;

  if (!plan) {
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  }

  const updates: string[] = [];
  const params: (string | number)[] = [];

  if (body.name !== undefined) {
    updates.push("name = ?");
    params.push(body.name);
  }
  if (body.amount !== undefined) {
    updates.push("amount = ?");
    params.push(body.amount);
  }
  if (body.currency !== undefined) {
    updates.push("currency = ?");
    params.push(body.currency);
  }
  if (body.interval !== undefined) {
    updates.push("\"interval\" = ?");
    params.push(body.interval);
  }
  if (body.max_numbers !== undefined) {
    updates.push("max_numbers = ?");
    params.push(body.max_numbers);
  }

  if (updates.length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  updates.push("updated_at = datetime('now')");
  params.push(body.id);

  db.prepare(
    `UPDATE plans SET ${updates.join(", ")} WHERE id = ?`,
  ).run(...params);

  // Sync to Stripe if requested (or if amount changed)
  let stripePriceId: string | null = null;
  if (body.syncStripe || body.amount !== undefined) {
    try {
      const updated = db
        .prepare("SELECT * FROM plans WHERE id = ?")
        .get(body.id) as Plan;
      stripePriceId = await syncStripePrice(updated);
    } catch (e) {
      console.warn("[Admin] Stripe price sync failed:", e);
    }
  }

  return NextResponse.json({
    success: true,
    stripe_price_id: stripePriceId,
  });
}
