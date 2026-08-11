import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-helpers";
import { getAmiClient } from "@/lib/ami";
import db from "@/lib/db";
import { z } from "zod";

export const dynamic = "force-dynamic";

const hangupSchema = z.object({
  extension_id: z.string().min(1, "Extension ID is required"),
});

export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const parsed = hangupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  const { extension_id } = parsed.data;

  // Verify the extension belongs to the authenticated user
  const ext = db
    .prepare(
      "SELECT extension_id FROM freepbx_extensions WHERE id = ? AND user_id = ?",
    )
    .get(extension_id, user.id) as { extension_id: string } | undefined;

  if (!ext) {
    return NextResponse.json(
      { error: "Extension not found or not owned by you" },
      { status: 404 },
    );
  }

  const client = getAmiClient();
  if (!client.isConnected) {
    return NextResponse.json(
      { error: "AMI not connected — cannot hang up channels" },
      { status: 503 },
    );
  }

  try {
    // Enumerate all active channels and filter for this extension
    const allChannels = await client.listChannels();
    const prefix = `PJSIP/${ext.extension_id}-`;
    const matching = allChannels.filter((ch) => ch.startsWith(prefix));

    if (matching.length === 0) {
      return NextResponse.json({
        success: true,
        hung_up: 0,
        message: "No active channels found for this extension",
      });
    }

    // Hang up each matching channel (fire-and-forget)
    for (const channel of matching) {
      client.sendActionAsync({ Action: "Hangup", Channel: channel });
    }

    console.log(
      `AMI Hangup: ${ext.extension_id} — hung up ${matching.length} channel(s): ${matching.join(", ")} (user: ${user.id})`,
    );

    return NextResponse.json({
      success: true,
      hung_up: matching.length,
      channels: matching,
    });
  } catch (e) {
    console.error("AMI Hangup failed:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Hangup request failed" },
      { status: 500 },
    );
  }
}
