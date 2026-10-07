import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-helpers";
import { getAmiClient } from "@/lib/ami";
import { callLegs } from "@/lib/ami-channels";
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
    // The extension's own legs, and the far ends they are bridged to. Hanging up
    // only the local leg relies on the bridge tearing its peer down on the way —
    // which is exactly what the caller reports *not* happening: they hang up and
    // the other party stays connected. So the peer is named and hung up too.
    const rows = await client.listChannelsDetailed();
    const { local, remote } = callLegs(rows, ext.extension_id);
    const channels = [...remote, ...local];

    if (channels.length === 0) {
      // Logged, not silent: this is also what a hang-up that ran *after* the
      // browser's own BYE looks like, and the caller decides what to do with it
      // (`hung_up_local: 0` means the BYE still has to be sent —
      // src/lib/call-teardown.ts).
      console.log(
        `AMI Hangup: ${ext.extension_id} — no active channel to clear ` +
          `(${rows.length} on the PBX) (user: ${user.id})`,
      );
      return NextResponse.json({
        success: true,
        hung_up: 0,
        hung_up_local: 0,
        hung_up_remote: 0,
        channels: [],
        message: "No active channels found for this extension",
      });
    }

    // The far end first, then the extension's own leg (fire-and-forget):
    // hanging the local leg up first can dissolve the bridge and race the
    // peer's own Hangup out of existence.
    for (const channel of channels) {
      client.sendActionAsync({ Action: "Hangup", Channel: channel });
    }

    console.log(
      `AMI Hangup: ${ext.extension_id} — hung up ${channels.length} channel(s) ` +
        `(${remote.length} far end): ${channels.join(", ")} (user: ${user.id})`,
    );

    return NextResponse.json({
      success: true,
      hung_up: channels.length,
      hung_up_local: local.length,
      hung_up_remote: remote.length,
      channels,
    });
  } catch (e) {
    console.error("AMI Hangup failed:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Hangup request failed" },
      { status: 500 },
    );
  }
}
