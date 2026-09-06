import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-helpers";
import db from "@/lib/db";
import type { Voicemail } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/voicemail?limit=20&offset=0
 *
 * Lists the caller's voicemails newest-first with the same pagination
 * contract as GET /api/fax/send (limit 1–100, default 20). Machine clients
 * (e.g. Capstone agents reading voicemail summaries) authenticate with the
 * account's `pbx_session` cookie or, where supported, a signed session
 * token — see docs/portal-api.md.
 */
export async function GET(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") ?? "20", 10) || 20, 1), 100);
  const offset = Math.max(parseInt(searchParams.get("offset") ?? "0", 10) || 0, 0);

  const total = (
    db.prepare("SELECT COUNT(*) as count FROM voicemails WHERE user_id = ?").get(user.id) as {
      count: number;
    }
  ).count;

  const voicemails = db
    .prepare(
      "SELECT * FROM voicemails WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
    )
    .all(user.id, limit, offset) as Voicemail[];

  return NextResponse.json({
    voicemails,
    total,
    offset,
    limit,
    hasMore: offset + voicemails.length < total,
  });
}
