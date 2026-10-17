import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-helpers";
import { checkOpenSms, isOpenSmsConfigured } from "@/lib/opensms";

export const dynamic = "force-dynamic";

/**
 * The local gateway's health, for the Messages composer.
 *
 * A configured-but-unreachable gateway is the common case (the phone is off
 * the charger), so this answers 200 either way — `health.ok` is the verdict.
 */
export async function GET() {
  const { error } = await requireUser();
  if (error) return error;

  if (!isOpenSmsConfigured()) {
    return NextResponse.json({ configured: false, health: null });
  }

  return NextResponse.json({
    configured: true,
    health: await checkOpenSms(),
  });
}
