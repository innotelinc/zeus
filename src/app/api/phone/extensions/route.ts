import { NextResponse } from "next/server";
import { requireUser, badRequest } from "@/lib/api-helpers";
import db from "@/lib/db";
import * as freepbx from "@/lib/freepbx";
import { getAmiClient } from "@/lib/ami";
import {
  provisionFragment,
  readFragmentState,
  removeFragment,
  type SoftphoneState,
} from "@/lib/pjsip-endpoint";
import { judgeExtension, isValidExtension } from "@/lib/extension-preflight";
import { readObservedExtensions } from "@/lib/extension-preflight-live";
import { randomUUID } from "node:crypto";
import type { FreePBXExtension } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const { user, error } = await requireUser();
  if (error) return error;

  const extensions = db
    .prepare("SELECT * FROM freepbx_extensions WHERE user_id = ? ORDER BY created_at DESC")
    .all(user.id) as FreePBXExtension[];

  return NextResponse.json({ extensions });
}

/**
 * Reload res_pjsip so a *provisioned* endpoint appears.
 *
 * Only ever called when an operator-owned file already includes the fragment.
 * The reload is what makes a written fragment live, so calling it while the
 * fragment is loaded any other way is how a duplicate `[<ext>]` — the object id
 * FreePBX generates for the same extension — gets activated, and a duplicate
 * object id makes sorcery refuse the whole pjsip configuration. A reload is
 * cheap; losing every endpoint on the box is not.
 */
async function reloadPjsipIfLive(state: SoftphoneState): Promise<void> {
  if (!state.provisioned) return;
  const ami = getAmiClient();
  if (!ami.isConnected) return;
  await ami
    .sendAction({ Action: "Command", Command: "module reload res_pjsip.so" })
    .catch(() => {});
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
    const secret = body.secret ?? randomUUID().replace(/-/g, "").slice(0, 16);
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

    // ── The WebRTC half ────────────────────────────────────
    // The extension exists in FreePBX at this point, so a failure here does not
    // roll it back: it is a real extension a hardware phone can use, and
    // deleting it because the softphone half could not be finished would
    // destroy the operator's work. What it must not do is report success — the
    // old code swallowed this into a comment and handed back a secret that
    // authenticated nothing.
    let softphone: SoftphoneState;
    try {
      softphone = provisionFragment(extensionId, secret);
    } catch (e) {
      softphone = {
        ...readFragmentState(extensionId),
        provisioned: false,
        reason:
          `the extension was created, but the WebRTC fragment could not be written: ` +
          `${e instanceof Error ? e.message : "unknown error"}. The secret below only works ` +
          `once ${"/etc/asterisk/pjsip_ext_" + extensionId + ".conf"} exists and is included.`,
      };
    }
    await reloadPjsipIfLive(softphone);

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

  // Read before removing: whether a reload is warranted depends on the
  // fragment having been loaded, not on the delete having succeeded.
  const before = readFragmentState(ext.extension_id);

  try {
    // Delete from FreePBX
    await freepbx.deleteExtension(ext.extension_id).catch(() => {
      // Non-critical — FreePBX may already have removed it
    });
  } catch {
    // Continue with local cleanup even if FreePBX fails
  }

  const danglingIncludes = removeFragment(ext.extension_id);
  await reloadPjsipIfLive(before);

  // Delete from local DB
  db.prepare("DELETE FROM freepbx_extensions WHERE id = ? AND user_id = ?").run(extId, user.id);

  return NextResponse.json({
    success: true,
    // Reported rather than edited: the includes that still name the deleted
    // fragment are in files the portal is not the owner of, and FreePBX drops
    // its own copy at the next Apply Config.
    dangling_includes: danglingIncludes,
    recovered: before.provisioned,
  });
}
