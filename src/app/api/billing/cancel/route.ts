import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import db from "@/lib/db";
import Stripe from "stripe";

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!stripe) {
    return NextResponse.json(
      { error: "Stripe is not configured" },
      { status: 500 },
    );
  }

  // Look up the Stripe subscription ID stored during checkout
  const row = db
    .prepare("SELECT stripe_subscription_id FROM users WHERE id = ?")
    .get(user.id) as { stripe_subscription_id: string | null } | undefined;

  if (!row?.stripe_subscription_id) {
    // No Stripe subscription on file — just update local status
    db.prepare(
      "UPDATE users SET plan_status = 'canceled', updated_at = datetime('now') WHERE id = ?",
    ).run(user.id);
    return NextResponse.json({ success: true, note: "no_stripe_subscription" });
  }

  try {
    // Cancel the subscription at period end (no immediate cancellation)
    await stripe.subscriptions.update(row.stripe_subscription_id, {
      cancel_at_period_end: true,
    });

    db.prepare(
      "UPDATE users SET plan_status = 'canceled', updated_at = datetime('now') WHERE id = ?",
    ).run(user.id);

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("[Billing] Stripe cancel error:", e);
    return NextResponse.json(
      { error: "Failed to cancel subscription with Stripe" },
      { status: 500 },
    );
  }
}
