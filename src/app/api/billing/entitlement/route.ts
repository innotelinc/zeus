import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-helpers";
import {
  magnateConfigured,
  magnateEntitlement,
} from "@/lib/magnate";

export const dynamic = "force-dynamic";

/**
 * GET /api/billing/entitlement?plan=agents
 *
 * Reports whether the signed-in Zeus user holds the requested add-on SKU on
 * Magnate (the shared billing platform). Magnate's subscription-level check
 * resolves the identity by username/email, so Zeus passes the dashboard
 * user's email; if that identity isn't found on Magnate the entitlement
 * falls back to the plan-level decision so a billing outage or identity
 * mismatch never masquerades as a hard denial.
 */
export async function GET(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;

  const plan =
    new URL(req.url).searchParams.get("plan")?.trim().toLowerCase() ?? "agents";

  if (!magnateConfigured()) {
    return NextResponse.json({
      configured: false,
      entitled: false,
      reason: "magnate_not_configured",
      plan,
    });
  }

  const identity = user.email ?? "";
  let decision = await magnateEntitlement(plan, { user: identity });

  // The identity on Zeus may differ from the one on Magnate (checkout user).
  // Retry without identity for a plan-level decision rather than a denial.
  if (identity && decision.source === "magnate" && decision.entitled === false) {
    const planLevel = await magnateEntitlement(plan);
    if (planLevel.source === "magnate" && planLevel.entitled !== false) {
      decision = {
        ...decision,
        entitled: planLevel.entitled,
        reason: planLevel.reason,
        status: planLevel.status,
        expiresAt: planLevel.expiresAt,
      };
    }
  }

  return NextResponse.json({
    configured: true,
    entitled: decision.entitled,
    reason: decision.reason,
    plan,
    slug: decision.slug,
    status: decision.status,
    expiresAt: decision.expiresAt,
    source: decision.source,
  });
}
