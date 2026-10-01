import { NextResponse } from "next/server";
import { requireUserOrService, notFound } from "@/lib/api-helpers";
import { SCOPE } from "@/lib/service-auth";
import { getFaxStatus } from "@/lib/avantfax";
import db from "@/lib/db";
import type { Fax } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/fax/[id] — the delivery answer for one fax.
 *
 * `POST /api/fax/send` returns `sent: true` when the *spool* accepted the job,
 * which is not the same as the fax arriving: AvantFax/HylaFAX reports the
 * transmission asynchronously, and a job can still come back `failed` (a wrong
 * number, a busy line, no answer). A client that stops at `sent` records a filing
 * as done that may never have been delivered — which is the one thing a document
 * on its way to the IRS must not do.
 *
 * So this route reads the row and, when it carries a job id, asks the spool for
 * the current state and answers with both. `state` is the three-way answer a
 * caller acts on (`sending` / `delivered` / `failed`); a terminal answer also
 * converges the stored row, so the portal's own list agrees.
 *
 * Machine clients (Genesis polling a filing) authenticate with a service token
 * scoped `fax:read`; a browser sends its session. Ownership is still `user_id`.
 */
const DELIVERY_STATE: Record<
  string,
  "sending" | "delivered" | "failed" | "unknown"
> = {
  pending: "sending",
  completed: "delivered",
  failed: "failed",
  unknown: "unknown",
};

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { user, error } = await requireUserOrService(req, SCOPE.faxRead);
  if (error) return error;

  const { id } = await params;

  const fax = db
    .prepare("SELECT * FROM faxes WHERE id = ? AND user_id = ?")
    .get(id, user.id) as Fax | undefined;
  if (!fax) return notFound("No such fax");

  if (!fax.job_id) {
    // Nothing to reconcile: the row was never handed to the spool, so there is
    // no spool answer to report. Saying `unknown` is honest; inventing
    // `delivered` from a local row is not.
    return NextResponse.json({
      fax,
      delivery: {
        state: "unknown",
        detail: "This fax carries no AvantFax job id — it was never sent.",
      },
    });
  }

  const status = await getFaxStatus(fax.job_id);
  const state = DELIVERY_STATE[status.status] ?? "unknown";

  if (state === "delivered" || state === "failed") {
    db.prepare(
      "UPDATE faxes SET status = ?, completed_at = COALESCE(completed_at, datetime('now')) WHERE id = ?",
    ).run(state === "delivered" ? "delivered" : "failed", fax.id);
  }

  const current = db.prepare("SELECT * FROM faxes WHERE id = ?").get(fax.id) as Fax;

  return NextResponse.json({
    fax: current,
    delivery: {
      state,
      status: status.status,
      pages: status.pages,
      result: status.result,
    },
  });
}
