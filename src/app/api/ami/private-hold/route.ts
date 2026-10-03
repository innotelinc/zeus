import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-helpers";
import { getAmiClient } from "@/lib/ami";
import db from "@/lib/db";
import { z } from "zod";

export const dynamic = "force-dynamic";

const schema = z.object({
  extension_id: z.string().min(1),
  active: z.boolean(),
});

function peerOf(rows: Array<Record<string, string>>, extension: string): string | null {
  const prefix = `PJSIP/${extension}-`;
  const own = rows.find((row) => (row.Channel ?? "").startsWith(prefix));
  if (!own) return null;

  const linked = own.BridgedChannel ?? own.BridgePeer ?? "";
  if (linked && !linked.startsWith(prefix)) return linked;

  const bridgeId = own.BridgeId ?? own.BridgeUniqueid ?? "";
  if (bridgeId) {
    const peer = rows.find((row) =>
      row.Channel !== own.Channel &&
      (row.BridgeId === bridgeId || row.BridgeUniqueid === bridgeId)
    );
    if (peer?.Channel) return peer.Channel;
  }
  return null;
}

export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "extension_id and active are required" }, { status: 400 });
  }

  const ext = db.prepare(
    "SELECT extension_id FROM freepbx_extensions WHERE id = ? AND user_id = ?",
  ).get(parsed.data.extension_id, user.id) as { extension_id: string } | undefined;
  if (!ext) {
    return NextResponse.json({ error: "Extension not found or not owned by you" }, { status: 404 });
  }

  const ami = getAmiClient();
  if (!ami.isConnected) {
    return NextResponse.json({ error: "AMI not connected" }, { status: 503 });
  }

  try {
    const peer = peerOf(await ami.listChannelDetails(), ext.extension_id);
    if (!peer) {
      return NextResponse.json(
        { error: "No bridged remote channel found for this extension" },
        { status: 409 },
      );
    }
    await ami.sendAction({
      Action: parsed.data.active ? "MusicOnHold" : "MusicOnHold",
      Channel: peer,
      State: parsed.data.active ? "on" : "off",
    });
    return NextResponse.json({ success: true, active: parsed.data.active });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Private hold failed" },
      { status: 500 },
    );
  }
}
