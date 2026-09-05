// @deprecated — legacy self-billing mode. Magnate (subscribe.innotel.us)
// is the single billing platform for the entire Innotel ecosystem.
// Leave STRIPE_SECRET_KEY empty when Magnate owns billing (the default).
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getOrCreateStripePriceId } from "@/lib/plans";
import Stripe from "stripe";

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

export async function POST(req: Request) {
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

  const { plan } = (await req.json()) as { plan?: string };
  const selectedPlan = plan ?? user.plan ?? "consumer";

  let priceId: string;
  try {
    priceId = await getOrCreateStripePriceId(selectedPlan);
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 },
    );
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      metadata: {
        user_id: user.id,
      },
      success_url: `${req.headers.get("origin") ?? "http://localhost:3000"}/dashboard/billing?success=true`,
      cancel_url: `${req.headers.get("origin") ?? "http://localhost:3000"}/dashboard/billing?canceled=true`,
      customer_email: user.email,
    });

    return NextResponse.json({ url: session.url });
  } catch (e) {
    console.error("[Billing] Stripe checkout error:", e);
    return NextResponse.json(
      { error: "Failed to create checkout session" },
      { status: 500 },
    );
  }
}
