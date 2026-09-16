import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-helpers";
import { buildIceServers } from "@/lib/rtc";

export const dynamic = "force-dynamic";

/**
 * ICE servers for the softphone (see src/lib/rtc.ts for why this is served at
 * request time rather than inlined into the client bundle).
 *
 * Authenticated because it hands out coturn's shared credential; a signed-in
 * user could read it from any call's SDP anyway, but there is no reason to
 * publish the relay to the open internet.
 */
export async function GET() {
  const { error } = await requireUser();
  if (error) return error;

  return NextResponse.json({ iceServers: buildIceServers() });
}
