import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";

export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // TODO: Cancel the Stripe subscription via stripe.subscriptions.update(subId, { cancel_at_period_end: true })
  // Currently only updates local DB status — Stripe will continue billing until manually cancelled.
  db.prepare("UPDATE users SET plan_status = 'canceled' WHERE id = ?").run(user.id);

  return NextResponse.json({ success: true });
}
