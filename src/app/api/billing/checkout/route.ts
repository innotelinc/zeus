import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
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

  // Map plans to Stripe price IDs (set these in your Stripe dashboard)
  const priceIds: Record<string, string> = {
    consumer: process.env.STRIPE_CONSUMER_PRICE_ID ?? "",
    business: process.env.STRIPE_BUSINESS_PRICE_ID ?? "",
  };

  const selectedPlan = plan ?? user.plan ?? "consumer";
  const priceId = priceIds[selectedPlan];

  if (!priceId) {
    return NextResponse.json(
      {
        error: `Stripe price ID not configured for "${selectedPlan}" plan. Set STRIPE_${selectedPlan.toUpperCase()}_PRICE_ID in your .env file.`,
      },
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
