import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-helpers";
import { buildIceServers } from "@/lib/rtc";
import { hostnameFromHostHeader, softphoneWssUrl } from "@/lib/softphone-wss";

export const dynamic = "force-dynamic";

/**
 * Runtime WebRTC config for the softphone: the ICE servers, and the WebSocket
 * endpoint to register against.
 *
 * Both are served at request time rather than inlined into the client bundle
 * (`NEXT_PUBLIC_*` is frozen at build time — see `src/lib/rtc.ts`), which is
 * what lets a deployment change its relay or its socket URL without a rebuild.
 * The socket URL specifically used to be a compose-inlined
 * `NEXT_PUBLIC_FREEPBX_WSS_URL` whose fallback was `wss://<host>:8089/ws`; on a
 * proxied deployment that port is closed, so the panel silently failed to
 * register. The Host header is the dashboard's own hostname, which is the input
 * the derivation rule needs, and it is resolved server-side so the answer is the
 * server's environment rather than CI's.
 *
 * Authenticated because it hands out coturn's shared credential; a signed-in
 * user could read it from any call's SDP anyway, but there is no reason to
 * publish the relay to the open internet. The socket URL is not a secret, but
 * it travels with the relay and gains nothing from a second endpoint.
 */
export async function GET(request: Request) {
  const { error } = await requireUser();
  if (error) return error;

  return NextResponse.json({
    iceServers: buildIceServers(),
    wssUrl: softphoneWssUrl(process.env, hostnameFromHostHeader(request.headers.get("host") ?? "")),
  });
}
