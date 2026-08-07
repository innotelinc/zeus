import { NextResponse } from "next/server";
import Stripe from "stripe";
import db from "@/lib/db";
import { buildInvoiceEmail } from "@/lib/mail-templates";

export const dynamic = "force-dynamic";

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

export async function POST(req: Request) {
  if (!stripe) {
    return NextResponse.json({ error: "Stripe not configured" }, { status: 500 });
  }

  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 },
    );
  }

  let event: Stripe.Event;
  try {
    const body = await req.text();
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // Handle checkout completion — store the subscription ID + activate plan
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const userId = session.metadata?.user_id;
    const subscriptionId =
      typeof session.subscription === "string" ? session.subscription : null;

    if (userId) {
      db.prepare(
        "UPDATE users SET plan_status = 'active', stripe_subscription_id = COALESCE(?, stripe_subscription_id), updated_at = datetime('now') WHERE id = ?",
      ).run(subscriptionId, userId);
    }
  }

  // Handle subscription deletion (customer cancelled or subscription ended)
  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object as Stripe.Subscription;

    db.prepare(
      "UPDATE users SET plan_status = 'canceled', stripe_subscription_id = NULL, updated_at = datetime('now') WHERE stripe_subscription_id = ?",
    ).run(subscription.id);
  }

  // Handle invoice payment
  if (event.type === "invoice.paid") {
    const invoice = event.data.object as Stripe.Invoice;
    const userId = invoice.metadata?.user_id;

    if (userId) {
      db.prepare(
        `UPDATE billing_invoices SET status = 'paid', amount_paid = amount_due, paid_at = datetime('now')
         WHERE user_id = ? AND status = 'pending'`,
      ).run(userId);

      // Get the invoice details for the email
      const inv = db
        .prepare(
          "SELECT bi.*, u.email, u.name FROM billing_invoices bi JOIN users u ON u.id = bi.user_id WHERE bi.user_id = ? AND bi.status = 'paid' ORDER BY bi.paid_at DESC LIMIT 1",
        )
        .get(userId) as
        | {
            invoice_number: string;
            amount_paid: number;
            period_start: string;
            period_end: string;
            email: string;
            name: string;
          }
        | undefined;

      if (inv) {
        buildInvoiceEmail({
          email: inv.email,
          name: inv.name,
          invoiceNumber: inv.invoice_number,
          amountPaid: inv.amount_paid,
          periodStart: inv.period_start,
          periodEnd: inv.period_end,
        }).catch(() => {});
      }
    }
  }

  return NextResponse.json({ received: true });
}
