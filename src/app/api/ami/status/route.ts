import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-helpers";
import { getAmiClient } from "@/lib/ami";
import db from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const { user, error } = await requireUser();
  if (error) return error;

  const client = getAmiClient();
  const connected = client.isConnected;

  // Get device states for this user's extensions
  const extensions = db
    .prepare(
      "SELECT extension_id, device_state FROM freepbx_extensions WHERE user_id = ?",
    )
    .all(user.id) as Array<{ extension_id: string; device_state: string }>;

  // Get active call count
  const activeCount = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM call_history WHERE user_id = ? AND status = 'answered'",
      )
      .get(user.id) as { c: number }
  ).c;

  // Get today's call count
  const todayCount = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM call_history WHERE user_id = ? AND created_at >= date('now')",
      )
      .get(user.id) as { c: number }
  ).c;

  return NextResponse.json({
    ami_connected: connected,
    extensions,
    active_calls: activeCount,
    today_calls: todayCount,
  });
}
