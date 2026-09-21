import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, badRequest } from "@/lib/api-helpers";
import db from "@/lib/db";
import { addonStatus } from "@/lib/addons";
import { avaConfigured, listAgents } from "@/lib/ava";

export const dynamic = "force-dynamic";

const mappingSchema = z.object({
  agent_slug: z.string().regex(/^[a-z0-9]{1,64}$/, "agent slug must be [a-z0-9], max 64"),
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
});

interface MappingRow {
  agent_slug: string;
  audio_profile: string | null;
  provider: string | null;
  updated_at: string;
}

/** GET /api/voice/agent-mapping — which agent answers this account's calls. */
export async function GET() {
  const { user, error } = await requireUser();
  if (error) return error;

  const mapping = db
    .prepare(
      "SELECT agent_slug, audio_profile, provider, updated_at FROM voice_agents WHERE user_id = ?",
    )
    .get(user.id) as MappingRow | undefined;

  return NextResponse.json({ mapping: mapping ?? null });
}

/**
 * PUT /api/voice/agent-mapping
 *
 * Point this account's inbound calls at one of its AVA agents. Writes require
 * an explicit entitlement, and the slug must exist on the engine — storing a
 * slug that does not exist would leave the account's calls answered by
 * nothing, because AVA routing fails closed on an unknown agent.
 */
export async function PUT(req: Request) {
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
  const parsed = mappingSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues.map((i) => i.message).join("; "));
  }

  const agents = await listAgents();
  if (agents.state !== "ok") {
    return NextResponse.json(
      { error: agents.error, ava_state: agents.state },
      { status: 503 },
    );
  }
  if (!agents.data.some((a) => a.slug === parsed.data.agent_slug)) {
    return badRequest(
      `No agent "${parsed.data.agent_slug}" on the voice engine — calls would not be answered`,
    );
  }

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
    parsed.data.agent_slug,
    parsed.data.audio_profile ?? null,
    parsed.data.provider ?? null,
  );

  return NextResponse.json({ success: true, mapping: parsed.data });
}
