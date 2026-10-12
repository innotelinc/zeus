import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-helpers";
import { getAmiClient } from "@/lib/ami";
import { ariConfigured, ariReachable, listHoldingChannels, setChannelHold } from "@/lib/ari";
import db from "@/lib/db";
import { z } from "zod";

export const dynamic = "force-dynamic";

const schema = z.object({
  extension_id: z.string().min(1),
  active: z.boolean(),
});

/**
 * The last channel this console held, per extension.
 *
 * Declaring a hold destroys the very thing that identifies the caller: Asterisk
 * answering the hold moves the peer out of the bridge and into a holding bridge,
 * so the AMI `Status` link the peer was found through is gone on the next read.
 * Keeping the channel *name* here is what lets a later GET ask the PBX about
 * that same channel; the state itself is still the PBX's answer, never this
 * map's. It holds no credentials and no call content, and a stale entry is
 * harmless — a channel that has hung up simply stops appearing in the bridge
 * list.
 */
const lastPeer = new Map<string, string>();

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

function extensionFor(userId: string, extensionId: string) {
  return db.prepare(
    "SELECT extension_id FROM freepbx_extensions WHERE id = ? AND user_id = ?",
  ).get(extensionId, userId) as { extension_id: string } | undefined;
}

/**
 * The current hold state, from the PBX.
 *
 * The console used to render this from a local boolean it set itself, which
 * cannot be right: the music a caller hears is started by Asterisk, so anything
 * else that holds the call (the far end, the carrier, a desk phone, another
 * operator) left the button reading "Resume" while the caller was on hold — or
 * "Connected" while they were not there at all. This reads the PBX's own
 * holding bridges instead, and also reports whether ARI is reachable, so a
 * Private Hold button that cannot work says so before it is pressed.
 */
export async function GET(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;

  const extensionId = new URL(req.url).searchParams.get("extension_id") ?? "";
  if (!extensionId) {
    return NextResponse.json({ error: "extension_id is required" }, { status: 400 });
  }
  const ext = extensionFor(user.id, extensionId);
  if (!ext) {
    return NextResponse.json({ error: "Extension not found or not owned by you" }, { status: 404 });
  }

  const ari = await ariReachable();
  const ami = getAmiClient();
  if (!ami.isConnected) {
    return NextResponse.json({ extension: ext.extension_id, ari, ami: "AMI not connected" });
  }

  try {
    const rows = await ami.listChannelDetails();
    const bridged = peerOf(rows, ext.extension_id);
    const peer = bridged ?? lastPeer.get(ext.extension_id) ?? null;

    let active: boolean | null = null;
    if (peer && !ari) {
      active = (await listHoldingChannels()).has(peer);
    }
    return NextResponse.json({
      extension: ext.extension_id,
      ari,
      peer,
      // null when the PBX could not be asked — never a guess.
      active,
      bridged: bridged !== null,
      held: active === true,
    });
  } catch (e) {
    return NextResponse.json({
      extension: ext.extension_id,
      ari,
      error: e instanceof Error ? e.message : "Hold state unreadable",
    });
  }
}

export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "extension_id and active are required" }, { status: 400 });
  }

  const ext = extensionFor(user.id, parsed.data.extension_id);
  if (!ext) {
    return NextResponse.json({ error: "Extension not found or not owned by you" }, { status: 404 });
  }

  const ami = getAmiClient();
  if (!ami.isConnected) {
    return NextResponse.json({ error: "AMI not connected" }, { status: 503 });
  }
  // AMI is what finds the bridged peer; holding it is ARI's job. Asterisk has
  // no `MusicOnHold` manager action at all, so an AMI that is up is not enough
  // to put a caller on music — and a hold that was never really engaged (or
  // worse, never released) is what leaves a caller stuck listening to it.
  if (!ariConfigured()) {
    return NextResponse.json(
      {
        error:
          "Private Hold needs ARI — set ASTERISK_ARI_BASE_URL, ASTERISK_ARI_USERNAME " +
          "and ASTERISK_ARI_PASSWORD",
      },
      { status: 503 },
    );
  }

  const release = !parsed.data.active;
  try {
    // Release is resolved from the same source as the state, not from the
    // caller's own leg: while a peer is held it is out of the bridge, so
    // `peerOf` finds nothing and a release that re-ran it would answer "no
    // bridged channel" while the caller stayed on music.
    const peer = release
      ? (lastPeer.get(ext.extension_id) ?? peerOf(await ami.listChannelDetails(), ext.extension_id))
      : peerOf(await ami.listChannelDetails(), ext.extension_id);
    if (!peer) {
      return NextResponse.json(
        { error: "No bridged remote channel found for this extension" },
        { status: 409 },
      );
    }
    // Hold the channel bridged with the extension, not the extension's own:
    // holding the operator's leg would play the music back at the operator.
    await setChannelHold(peer, !release);
    if (release) {
      lastPeer.delete(ext.extension_id);
    } else {
      lastPeer.set(ext.extension_id, peer);
    }

    // Answer with the PBX's state, not the request it was just sent. A hold
    // that was refused is a failure the operator has to see; a hold that was
    // taken off elsewhere should not leave the button lying about it.
    let active: boolean | null = null;
    try {
      active = (await listHoldingChannels()).has(peer);
    } catch {
      // Unreadable state is reported as null rather than as false: the UI
      // keeps the request's own value only when the PBX had nothing to say.
    }
    return NextResponse.json({
      success: true,
      requested: parsed.data.active,
      peer,
      active: active ?? parsed.data.active,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Private hold failed" },
      { status: 500 },
    );
  }
}
