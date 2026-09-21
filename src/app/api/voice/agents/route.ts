import { NextResponse } from "next/server";
import { requireUser, badRequest } from "@/lib/api-helpers";
import { addonStatus } from "@/lib/addons";
import {
  avaConfigured,
  createAgent,
  createAgentSchema,
  listAgents,
  type AvaAgent,
} from "@/lib/ava";

export const dynamic = "force-dynamic";

/**
 * GET /api/voice/agents
 *
 * The AVA agents this account may use. Reads are allowed even when the
 * add-on check is inconclusive — an operator needs to be able to see why
 * calls are not being answered — but the response always carries the
 * add-on state so the UI never presents an unentitled agent as usable.
 */
export async function GET() {
  const { user, error } = await requireUser();
  if (error) return error;

  const addon = await addonStatus("agents", { user: user.email });

  if (!avaConfigured()) {
    return NextResponse.json({
      configured: false,
      agents: [],
      addon,
    });
  }

  const result = await listAgents();
  if (result.state !== "ok") {
    // Surface the engine's state rather than an empty list: "quiet" and
    // "broken" must not look the same in the dashboard.
    return NextResponse.json(
      { configured: true, error: result.error, ava_state: result.state, agents: [], addon },
      { status: result.state === "unreachable" ? 503 : 502 },
    );
  }

  return NextResponse.json({
    configured: true,
    ava_state: result.state,
    agents: result.data as AvaAgent[],
    addon,
  });
}

/**
 * POST /api/voice/agents
 *
 * Create an agent. Writes require an explicit entitlement: creating an agent
 * is what turns the add-on on for an account's calls, so an inconclusive
 * check must not allow it (see lib/addons.ts).
 */
export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;

  const addon = await addonStatus("agents", { user: user.email });
  if (addon.state !== "enabled") {
    return NextResponse.json(
      {
        error:
          addon.state === "unknown"
            ? "Could not verify the AI voice agent add-on — try again once billing is reachable"
            : "The AI voice agent add-on is not enabled for this account",
        addon,
      },
      { status: 402 },
    );
  }

  if (!avaConfigured()) {
    return NextResponse.json(
      { error: "The voice engine is not configured on this deployment" },
      { status: 503 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const parsed = createAgentSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues.map((i) => i.message).join("; "));
  }

  const result = await createAgent(parsed.data);
  if (result.state !== "ok") {
    return NextResponse.json(
      { error: result.error, ava_state: result.state },
      { status: result.state === "unreachable" ? 503 : 502 },
    );
  }

  return NextResponse.json({ success: true, agent: result.data }, { status: 201 });
}
