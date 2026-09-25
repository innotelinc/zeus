import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, badRequest } from "@/lib/api-helpers";
import db from "@/lib/db";
import { addonStatus } from "@/lib/addons";
import { recordAddonDecision } from "@/lib/addon-cache";
import { dograhConfigured, listWorkflows } from "@/lib/dograh";
import { isSafeCapstoneTarget } from "@/lib/dialplan-values";
import { accountLines, resolveOwnedDid, setBinding } from "@/lib/voice-bindings";

export const dynamic = "force-dynamic";

const mappingSchema = z.object({
  /**
   * The workflow this line reaches. `null` (or the empty string) clears it;
   * absent leaves the line alone.
   *
   * This was `capstone_binding` and still is, on disk and in the dialplan —
   * the column, the route variable and `ZEUS_CAPSTONE_TARGET` all keep their
   * names because renaming them would mean a migration whose only benefit is
   * vocabulary. What changed is what fills it: an agent is a Dograh workflow
   * now, so the value is validated against Dograh's list rather than trusted
   * as a free-text extension.
   */
  capstone_binding: z.string().optional().nullable(),
  /** Which of the account's numbers the binding is for. */
  did: z.string().optional(),
});

/**
 * GET /api/voice/agent-mapping — which workflow each of this account's numbers
 * reaches.
 *
 * `lines` is the per-DID half. There used to be an account-level `mapping`
 * beside it, naming one AVA agent for the whole account; that concept is gone.
 * A workflow is a property of the *number* — one account can hold a support
 * line and an interview line — and keeping an account-wide agent would mean two
 * places to look for the same answer.
 */
export async function GET() {
  const { user, error } = await requireUser();
  if (error) return error;

  const capstone = await addonStatus("capstone", { user: user.email });

  return NextResponse.json({
    lines: accountLines(user.id),
    capstone: { state: capstone.state, reason: capstone.reason },
  });
}

/**
 * PUT /api/voice/agent-mapping
 *
 * Say which workflow one of this account's numbers reaches.
 *
 * The write is a single transaction with the entitlement answer that authorised
 * it (`src/lib/addon-cache.ts`): the binding and the reason it was allowed to
 * exist commit together, so the audit trail can never describe a state the
 * routing does not have.
 *
 * Two checks guard the value, and they are different questions:
 *
 *   1. **Syntax** — the renderer's own charset (`src/lib/dialplan-values.ts`).
 *      The value is interpolated into `DIALPLAN_EXISTS(dograh-inbound,
 *      ${ZEUS_CAPSTONE_TARGET},1)`, so a `)` in it would close that call and
 *      inject the rest. Enforced on the way in as well as on the way out, so a
 *      bad target cannot be stored by this API and discovered by the renderer.
 *   2. **Existence** — whether Dograh actually has that workflow. Unknown
 *      values are refused rather than stored: a binding nothing answers is a
 *      number that rings and then refuses to an operator, which is a worse
 *      outcome than an error message here.
 *
 * Existence is only *enforced* when the engine can be read. With Dograh
 * unreachable a syntactically valid value is refused too — failing closed,
 * because the alternative is accepting an extension on a guess.
 */
export async function PUT(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;

  const body = await req.json().catch(() => ({}));
  const parsed = mappingSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues.map((i) => i.message).join("; "));
  }

  const touchesBinding = Object.prototype.hasOwnProperty.call(body, "capstone_binding");
  if (!touchesBinding) {
    return badRequest("nothing to update: send capstone_binding, and the did it is for");
  }

  const { capstone_binding: binding, did } = parsed.data;
  const clearsBinding = binding === null || binding === "";

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

  if (!did) return badRequest("did is required when setting a workflow binding");
  const bindingDid = resolveOwnedDid(user.id, did);
  if (!bindingDid) {
    return badRequest(`This account has no active number ${did}`);
  }

  if (!clearsBinding) {
    // Narrowed once here rather than at every use: `clearsBinding` is exactly
    // `binding` being null or empty, so anything below is a real string.
    const target = binding ?? "";
    if (!isSafeCapstoneTarget(target)) {
      return badRequest(
        "workflow target must be [A-Za-z0-9_.:-], max 64 — it is used inside a dialplan function",
      );
    }

    if (!dograhConfigured()) {
      return NextResponse.json(
        {
          error:
            "The voice engine is not configured on this deployment, so no workflow can be " +
            "checked — refusing rather than storing a target nothing answers",
        },
        { status: 503 },
      );
    }

    const workflows = await listWorkflows();
    if (workflows.state !== "ok") {
      return NextResponse.json(
        { error: workflows.error, dograh_state: workflows.state },
        { status: 503 },
      );
    }

    // Accept the workflow's id or its name, and store what was matched: the
    // dialplan resolves the target as an extension in `[dograh-inbound]`, and
    // Capstone's sync publishes both spellings there.
    const known = workflows.data.some(
      (workflow) => String(workflow.id) === target || workflow.name === target,
    );
    if (!known) {
      return badRequest(
        `No workflow "${target}" on the voice engine — the line would ring and then refuse`,
      );
    }
  }

  const write = db.transaction(() => {
    setBinding(user.id, bindingDid, clearsBinding ? null : binding ?? null);
    recordAddonDecision(user.id, "capstone", true);
  });
  write();

  return NextResponse.json({
    success: true,
    lines: accountLines(user.id),
  });
}
