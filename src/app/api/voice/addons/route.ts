import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-helpers";
import { ADDONS, addonStatuses } from "@/lib/addons";

export const dynamic = "force-dynamic";

/**
 * GET /api/voice/addons
 *
 * Which voice add-ons this account holds, and what each one unlocks. The
 * dashboard reads this to decide whether to show the Voice and Capstone
 * screens, and it is the same helper the routing path uses — so a screen can
 * never be shown for an add-on whose routing is refused.
 *
 * `state` is "enabled" | "disabled" | "unknown"; "unknown" means the
 * entitlement source could not be reached, and the UI must say so instead of
 * presenting it as off.
 */
export async function GET() {
  const { user, error } = await requireUser();
  if (error) return error;

  const statuses = await addonStatuses({ user: user.email });

  return NextResponse.json({
    addons: statuses.map((status) => ({
      ...ADDONS[status.sku],
      state: status.state,
      reason: status.reason,
    })),
  });
}
