import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getAmiClient } from "@/lib/ami";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * The PBX-side remedy for a softphone that will not register — over AMI, the
 * only channel the portal has.
 *
 * `POST /api/phone/extensions/repair` fixes a *row*: it adopts the secret the
 * PBX renders and rewrites `[<ext>](+)`. It cannot fix a PBX whose live state
 * has gone stale — a transport that never rebound, an endpoint Asterisk kept
 * from before a writer landed, a rejected trunk registration. Those are the
 * cases where the operator's own answer is "restart the PBX", and until now
 * the only way to run it was a shell on the host.
 *
 * Two modes, because they are different blast radii and only one is usually
 * needed:
 *
 *   * `reload`  — `module reload res_pjsip.so`, exactly what
 *     `src/lib/pjsip-reload.ts` sends after a write. Re-reads every endpoint,
 *     aor and transport from disk. Live calls survive.
 *   * `restart` — `core restart now`, the command the PBX entrypoint itself
 *     runs (docker-entrypoint-full.sh). Drops every call and rebuilds the
 *     transports, which is what a WSS bind that never came back needs. This is
 *     the one that costs a few seconds of silence, so it is not the default.
 *
 * Admin-only, deliberately: a reload is estate-wide, not account-scoped.
 *
 * `core restart now` tears down the AMI connection the command arrived on, so
 * the restart is sent `Async` — waiting for a reply that cannot arrive would
 * turn a working restart into a 500 after the 10s action timeout. The client
 * reconnects on its own (`scheduleReconnect`), which is why the response says
 * the link dropped rather than claiming a synchronous success.
 */
const schema = z.object({
  mode: z.enum(["reload", "restart"]).default("restart"),
});

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (user.role !== "admin") {
    return NextResponse.json(
      { error: "Admin access required — this reloads the PBX for every account" },
      { status: 403 },
    );
  }

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "mode must be 'reload' or 'restart'" },
      { status: 400 },
    );
  }
  const { mode } = parsed.data;

  const ami = getAmiClient();
  if (!ami.isConnected) {
    // The same refusal the rest of the voice plane gives: a reload that cannot
    // be sent is not a reload, and reporting success would be the silent
    // no-op this route exists to avoid.
    return NextResponse.json(
      { error: "AMI is not connected — cannot reach the PBX" },
      { status: 503 },
    );
  }

  if (mode === "reload") {
    try {
      const response = await ami.sendAction({
        Action: "Command",
        Command: "module reload res_pjsip.so",
      });
      return NextResponse.json({
        success: true,
        mode,
        message: "PJSIP reloaded — a softphone can register again.",
        output: response.Output ?? "",
      });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Reload failed" },
        { status: 500 },
      );
    }
  }

  // Restart: fire and forget. The reply would ride the connection this command
  // kills (see the docstring), so waiting on it can only ever time out.
  ami.sendActionAsync({ Action: "Command", Command: "core restart now" });
  return NextResponse.json({
    success: true,
    mode,
    message:
      "Restarting Asterisk — every call drops and the PBX is unreachable for a few seconds.",
  });
}
