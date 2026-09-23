import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, badRequest } from "@/lib/api-helpers";
import db from "@/lib/db";
import { addonStatus } from "@/lib/addons";
import { recordAddonDecision } from "@/lib/addon-cache";
import { avaConfigured, listAgents } from "@/lib/ava";
import { isSafeCapstoneTarget } from "@/lib/dialplan-values";
import { accountLines, resolveOwnedDid, setBinding } from "@/lib/voice-bindings";

export const dynamic = "force-dynamic";

const mappingSchema = z.object({
  agent_slug: z
    .string()
    .regex(/^[a-z0-9]{1,64}$/, "agent slug must be [a-z0-9], max 64")
    .optional(),
  audio_profile: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{1,64}$/, "audio profile contains unsupported characters")
    .optional()
    .nullable(),
  provider: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{1,64}$/, "provider contains unsupported characters")
    .optional()
    .nullable(),
  /**
   * The interview workflow this line reaches. `null` (or the empty string)
   * clears it; absent leaves the line alone.
   */
  capstone_binding: z.string().optional().nullable(),
  /** Which of the account's numbers the binding is for. */
  did: z.string().optional(),
});

interface MappingRow {
  agent_slug: string;
  audio_profile: string | null;
  provider: string | null;
  updated_at: string;
}

/**
 * GET /api/voice/agent-mapping — which agent answers this account's calls, and
 * which interview workflow each of its numbers reaches.
 *
 * `lines` is the per-DID half (§7 of the design: the agent choice and the
 * binding belong to one form, and the form has to be able to show what is
 * stored before it overwrites it).
 */
export async function GET() {
  const { user, error } = await requireUser();
  if (error) return error;

  const mapping = db
    .prepare(
      "SELECT agent_slug, audio_profile, provider, updated_at FROM voice_agents WHERE user_id = ?",
    )
    .get(user.id) as MappingRow | undefined;

  const capstone = await addonStatus("capstone", { user: user.email });

  return NextResponse.json({
    mapping: mapping ?? null,
    lines: accountLines(user.id),
    capstone: { state: capstone.state, reason: capstone.reason },
  });
}

/**
 * PUT /api/voice/agent-mapping
 *
 * Point this account's inbound calls at one of its AVA agents, and/or say which
 * Capstone interview workflow one of its numbers reaches. Both writes are one
 * transaction: the add-on enablement path in the design (§7, D5) is "entitlement
 * → routing → UI in one write", and two writes that can disagree about what an
 * account bought are the defect this table exists to remove.
 *
 * The entitlement answer that authorised the write is recorded **in the same
 * transaction** (`src/lib/addon-cache.ts`): the mapping and the reason it was
 * allowed to exist commit together, so the audit trail can never describe a
 * state the routing does not have.
 *
 * Every field is optional, but at least one must be present — the route is the
 * account's voice mapping, not a patch of one column.
 *
 * The agent slug must exist on the engine: storing a slug that does not exist
 * would leave the account's calls answered by nothing, because AVA routing fails
 * closed on an unknown agent. A Capstone target is held to the renderer's own
 * charset (`src/lib/dialplan-values.ts`), so a value that could close
 * `DIALPLAN_EXISTS(...)` never reaches `voice_bindings` in the first place.
 */
export async function PUT(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;

  const body = await req.json().catch(() => ({}));
  const parsed = mappingSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues.map((i) => i.message).join("; "));
  }

  const { agent_slug: agentSlug, capstone_binding: binding, did } = parsed.data;
  const touchesBinding = Object.prototype.hasOwnProperty.call(body, "capstone_binding");
  const clearsBinding = touchesBinding && (binding === null || binding === "");

  if (!agentSlug && !touchesBinding) {
    return badRequest("nothing to update: send agent_slug, capstone_binding, or both");
  }

  // ── The agent half ────────────────────────────────────────────
  if (agentSlug) {
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

    const agents = await listAgents();
    if (agents.state !== "ok") {
      return NextResponse.json(
        { error: agents.error, ava_state: agents.state },
        { status: 503 },
      );
    }
    if (!agents.data.some((a) => a.slug === agentSlug)) {
      return badRequest(
        `No agent "${agentSlug}" on the voice engine — calls would not be answered`,
      );
    }
  }

  // ── The interview-line half ───────────────────────────────────
  // Resolved before either write, so a request that names a number this account
  // does not hold fails without having changed the agent choice.
  let bindingDid: string | null = null;
  if (touchesBinding) {
    const capstone = await addonStatus("capstone", { user: user.email });
    if (capstone.state !== "enabled") {
      return NextResponse.json(
        {
          error:
            capstone.state === "unknown"
              ? "Could not verify the Capstone add-on — try again once billing is reachable"
              : "The Capstone interview add-on is not enabled for this account",
          capstone: { state: capstone.state, reason: capstone.reason },
        },
        { status: 402 },
      );
    }

    if (!did) return badRequest("did is required when setting a Capstone binding");
    bindingDid = resolveOwnedDid(user.id, did);
    if (!bindingDid) {
      return badRequest(`This account has no active number ${did}`);
    }

    if (binding && !isSafeCapstoneTarget(binding)) {
      return badRequest(
        "Capstone target must be [A-Za-z0-9_.:-], max 64 — it is used inside a dialplan function",
      );
    }
  }

  // The answers acted on above. Both branches below are only reachable when the
  // gate answered `enabled`, and `enabled` is exactly the entitled set — so
  // `true` here is the decision this write was authorised by, not a guess. An
  // indecisive or refused gate returned 402 before reaching this point and
  // records nothing, which is what keeps a rejected Magnate token from leaving
  // a "not entitled" row behind it.
  const write = db.transaction(() => {
    if (agentSlug) {
      db.prepare(
        `INSERT INTO voice_agents (user_id, agent_slug, audio_profile, provider, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(user_id)
           DO UPDATE SET agent_slug = excluded.agent_slug,
                         audio_profile = excluded.audio_profile,
                         provider = excluded.provider,
                         updated_at = excluded.updated_at`,
      ).run(
        user.id,
        agentSlug,
        parsed.data.audio_profile ?? null,
        parsed.data.provider ?? null,
      );
      recordAddonDecision(user.id, "agents", true);
    }
    if (bindingDid) {
      setBinding(user.id, bindingDid, clearsBinding ? null : binding ?? null);
      recordAddonDecision(user.id, "capstone", true);
    }
  });
  write();

  return NextResponse.json({
    success: true,
    mapping: agentSlug ? parsed.data : undefined,
    lines: accountLines(user.id),
  });
}
