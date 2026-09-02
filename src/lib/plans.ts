import db from "./db";
import Stripe from "stripe";

export interface Plan {
  id: string;
  name: string;
  stripe_price_id: string | null;
  amount: number;
  currency: string;
  interval: string;
  max_numbers: number;
}

/** Get all plans from DB. */
export function getPlans(): Plan[] {
  return db
    .prepare("SELECT * FROM plans ORDER BY amount ASC")
    .all() as Plan[];
}

/** Get a single plan by ID. */
export function getPlan(id: string): Plan | undefined {
  return db
    .prepare("SELECT * FROM plans WHERE id = ?")
    .get(id) as Plan | undefined;
}

/** Sync a plan's Stripe price — creates or updates the Stripe price object.
 *  Returns the Stripe price ID to store in the DB. */
export async function syncStripePrice(plan: Plan): Promise<string> {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "");

  // Create a new Stripe product if we don't have one stored
  const productName = `Zeus ${plan.name} Plan`;

  // Check if we already have a price in Stripe
  if (plan.stripe_price_id) {
    try {
      // Deactivate old price, create new one (Stripe prices are immutable)
      await stripe.prices.update(plan.stripe_price_id, { active: false });
    } catch {
      // Old price may not exist — ignore
    }
  }

  // Create a new product (or reuse first one)
  const products = await stripe.products.list({ limit: 1, active: true });
  let productId = products.data[0]?.id;

  if (!productId) {
    const product = await stripe.products.create({
      name: productName,
      statement_descriptor: "ZEUS VOIP",
    });
    productId = product.id;
  }

  // Update product name if plan name changed
  await stripe.products.update(productId, { name: productName });

  // Create new price
  const price = await stripe.prices.create({
    product: productId,
    unit_amount: plan.amount,
    currency: plan.currency,
    recurring: { interval: plan.interval as "month" | "year" },
    metadata: { plan_id: plan.id },
  });

  // Store the price ID in the DB
  db.prepare(
    "UPDATE plans SET stripe_price_id = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(price.id, plan.id);

  return price.id;
}

/** Get the Stripe price ID for a plan, syncing if needed. */
export async function getOrCreateStripePriceId(planId: string): Promise<string> {
  const plan = getPlan(planId);
  if (!plan) throw new Error(`Plan "${planId}" not found`);

  if (plan.stripe_price_id && plan.amount > 0) {
    return plan.stripe_price_id;
  }

  if (plan.amount === 0) {
    throw new Error(`Plan "${planId}" has no price set`);
  }

  return syncStripePrice(plan);
}

/** Get display label for a plan. */
export function getPlanLabel(planId: string): string {
  const plan = getPlan(planId);
  return plan?.name ?? planId.charAt(0).toUpperCase() + planId.slice(1);
}

/** Get formatted price string for a plan. */
export function getPlanPrice(planId: string): string {
  const plan = getPlan(planId);
  if (!plan || plan.amount === 0) return "Free";
  const dollars = (plan.amount / 100).toFixed(2);
  const interval = plan.interval === "year" ? "/yr" : "/mo";
  return `$${dollars}${interval}`;
}
