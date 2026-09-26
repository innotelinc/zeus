import { NextResponse } from "next/server";
import { requireUser, badRequest } from "@/lib/api-helpers";
import db from "@/lib/db";
import * as freepbx from "@/lib/freepbx";
import {
  POST_FILE,
  provisionMediaAddress,
  provisionWebrtc,
  readWebrtcState,
  removeLegacyFragment,
  removeWebrtc,
  sectionHeader,
  type MediaAddressState,
  type SoftphoneState,
} from "@/lib/pjsip-endpoint";
import { pbxSecretFor } from "@/lib/pjsip-secret";
import { reloadPjsipIfLive } from "@/lib/pjsip-reload";
import { judgeExtension, isValidExtension } from "@/lib/extension-preflight";
import { withSoftphoneReadiness } from "@/lib/extension-readiness-server";
import { readObservedExtensions } from "@/lib/extension-preflight-live";
import { randomUUID } from "node:crypto";
import type { FreePBXExtension } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const { user, error } = await requireUser();
  if (error) return error;

  const extensions = withSoftphoneReadiness(
    db
      .prepare("SELECT * FROM freepbx_extensions WHERE user_id = ? ORDER BY created_at DESC")
      .all(user.id) as FreePBXExtension[],
  );

  return NextResponse.json({ extensions });
}

export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;

  const body = await req.json().catch(() => ({}));

  if (!body.extensionId || !body.name || !body.email) {
    return badRequest("extensionId, name, and email are required");
  }

  const extensionId = String(body.extensionId).trim();
  if (!isValidExtension(extensionId)) {
    return badRequest(
      "extensionId must be 2-8 digits — a user/device is a number you dial, and " +
        "every consumer on this box assumes digits",
    );
  }

  // ── The preflight (D6 / P3) ────────────────────────────────────
  // This route used to be the *second* writer D6 exists to remove: it called
  // `freepbx.addExtension` without asking whether the number was safe to create
  // over, which is how a raw `(1,'maxchans')` collision surfaced as an
  // unactionable dialog. It now consults the same judgement the PBX-side
  // provisioner makes (`src/lib/extension-preflight.ts`) before it writes.
  //
  // A measurement that could not be taken is a refusal, not a green light: an
  // unread source read as "nothing there" is exactly how a new phone inherits a
  // deleted one's call forwarding.
  const preflight = await readObservedExtensions(extensionId);
  if (!preflight.ok) {
    return NextResponse.json(
      {
        error: "preflight_unavailable",
        reason: `could not check whether ${extensionId} is safe to create: ${preflight.reason}`,
        repair:
          "run the PBX-side preflight on the voice host — `python3 pbx/provision_extension.py " +
          "--intent <intent.json> --check` — or restore AMI and the Asterisk config mount",
      },
      { status: 503 },
    );
  }

  const verdict = judgeExtension({ extension: extensionId, name: String(body.name).trim() }, preflight.observed);
  if (verdict.state === "refuse") {
    return NextResponse.json(
      { error: "extension_not_creatable", reason: verdict.reason, repair: verdict.repair },
      { status: 409 },
    );
  }
  if (verdict.state === "in-sync") {
    return NextResponse.json(
      {
        error: "extension_exists",
        reason: `${extensionId} already exists in FreePBX (a user and a device) — creating it again would collide`,
        repair: "delete it first, or choose another number",
      },
      { status: 409 },
    );
  }

  try {
    const vmPin = body.vmPassword ?? Math.random().toString().slice(2, 6);

    const result = await freepbx.addExtension({
      extensionId,
      name: body.name,
      email: body.email,
      tech: "pjsip",
      vmEnable: body.vmEnable ?? true,
      vmPassword: vmPin,
    });

    if (!result.addExtension.status) {
      return NextResponse.json(
        { error: result.addExtension.message },
        { status: 500 },
      );
    }

    // ── The credential ─────────────────────────────────────
    // FreePBX generates the device secret, and since the endpoint decision that
    // is the credential the softphone must use: the browser registers as the
    // same `[<ext>]` the PBX routes to and reports device state for, so it has
    // to authenticate as that object. FreePBX's API will not hand the secret
    // back (`addExtension` returns no such field), so it is read out of the
    // rendered config (§11.5's "read path of its own" — src/lib/pjsip-secret.ts)
    // and, failing that, a portal-issued one is stored and the readiness row
    // reports the mismatch rather than pretending the phone will register.
    const pbxSecret = pbxSecretFor(extensionId);
    const secret = pbxSecret || body.secret || randomUUID().replace(/-/g, "").slice(0, 16);

    // ── The WebRTC half ────────────────────────────────────
    // The extension exists in FreePBX at this point, so a failure here does not
    // roll it back: it is a real extension a hardware phone can use, and
    // deleting it because the softphone half could not be finished would
    // destroy the operator's work. What it must not do is report success — the
    // old code swallowed this into a comment and handed back a secret that
    // authenticated nothing.
    let softphone: SoftphoneState;
    try {
      softphone = provisionWebrtc(extensionId);
    } catch (e) {
      softphone = {
        ...readWebrtcState(extensionId),
        provisioned: false,
        reason:
          `the extension was created, but its WebRTC settings could not be written: ` +
          `${e instanceof Error ? e.message : "unknown error"}. The endpoint FreePBX owns has ` +
          `no DTLS/ICE media until ${POST_FILE} carries ${sectionHeader(extensionId)}.`,
      };
    }
    // ── The media address the phone is handed ───────────────
    // A phone created between boots would otherwise be handed the PBX's own
    // (container) address until the next restart, and lose its voice and every
    // DTMF digit in the direction nobody notices. The boot owner converges the
    // whole estate; this write covers the one created now. A missing address is
    // reported, not fabricated.
    let media: MediaAddressState;
    try {
      media = provisionMediaAddress(extensionId);
    } catch (e) {
      media = {
        written: false,
        file: "pjsip_media_custom.conf",
        address: "",
        reason:
          `the extension was created, but its media address could not be written: ` +
          `${e instanceof Error ? e.message : "unknown error"}. The boot owner ` +
          `(pbx/media_address.py) will converge it at the next restart.`,
      };
    }
    // A media write is a change to a loaded file too, so reload for either half.
    await reloadPjsipIfLive(media.written ? { ...softphone, provisioned: true } : softphone);

    const extId = randomUUID();
    db.prepare(
      `INSERT INTO freepbx_extensions (id, user_id, extension_id, extension_name, extension_secret, voicemail_enabled, voicemail_pin, status, device_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'offline')`,
    ).run(extId, user.id, extensionId, body.name, secret, body.vmEnable ? 1 : 0, vmPin);

    return NextResponse.json(
      {
        success: true,
        extensionId,
        secret,
        message: result.addExtension.message,
        softphone,
        media,
      },
      { status: 201 },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "FreePBX provisioning failed" },
      { status: 502 },
    );
  }
}

export async function DELETE(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;

  const { searchParams } = new URL(req.url);
  const extId = searchParams.get("id");
  if (!extId) return badRequest("id query parameter is required");

  // Verify ownership
  const ext = db
    .prepare("SELECT * FROM freepbx_extensions WHERE id = ? AND user_id = ?")
    .get(extId, user.id) as FreePBXExtension | undefined;

  if (!ext) {
    return NextResponse.json({ error: "Extension not found" }, { status: 404 });
  }

  // Read before removing: whether a reload is warranted depends on our
  // settings having been loaded, not on the delete having succeeded.
  const before = readWebrtcState(ext.extension_id);

  try {
    // Delete from FreePBX
    await freepbx.deleteExtension(ext.extension_id).catch(() => {
      // Non-critical — FreePBX may already have removed it
    });
  } catch {
    // Continue with local cleanup even if FreePBX fails
  }

  // Both shapes: ours (the append settings, in a file the portal owns) and the
  // pre-decision fragment, which is nobody's endpoint now and a duplicate id if
  // anything ever loads it — so a delete cleans it up rather than leaving it to
  // be found by `pjsip_owner_check.py` later.
  removeWebrtc(ext.extension_id);
  const removedLegacyFragment = removeLegacyFragment(ext.extension_id);
  await reloadPjsipIfLive(before);

  // Delete from local DB
  db.prepare("DELETE FROM freepbx_extensions WHERE id = ? AND user_id = ?").run(extId, user.id);

  return NextResponse.json({
    success: true,
    removed_settings: before.provisioned,
    // Named because a stale pjsip_ext_<ext>.conf is the one leftover that can
    // break the PBX for every *other* extension too.
    removed_leftover_endpoint_file: removedLegacyFragment,
  });
}
