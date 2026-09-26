import { NextResponse } from "next/server";
import { requireUser, badRequest } from "@/lib/api-helpers";
import db from "@/lib/db";
import { MEDIA_FILE, POST_FILE, provisionMediaAddress, provisionWebrtc, readWebrtcState, removeLegacyFragment, sectionHeader } from "@/lib/pjsip-endpoint";
import { pbxSecretFor } from "@/lib/pjsip-secret";
import { reloadPjsipIfLive } from "@/lib/pjsip-reload";
import { assessSoftphone } from "@/lib/extension-readiness";
import type { FreePBXExtension } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Repair an extension's softphone half.
 *
 * Every fault the console can name is either data or one section this portal
 * owns, so all of them converge on the same three writes:
 *
 *   1. **Adopt the secret FreePBX renders.** Since the endpoint decision the
 *      softphone registers as the endpoint the PBX routes to, so the PBX's
 *      device secret is the credential — a portal-issued one is a 401 for ever.
 *   2. **Write `[<ext>](+)` and the WebRTC media into
 *      `pjsip.endpoint_custom_post.conf`**, which appends to the endpoint
 *      FreePBX generates. One object, one owner; no include, so nothing to be
 *      dropped by the next Apply Config.
 *   3. **Remove a pre-decision `pjsip_ext_<ext>.conf`**, which defines a second
 *      `[<ext>]` beside FreePBX's. That is the migration, and leaving it while
 *      adding the append section would produce exactly the duplicate id the
 *      decision exists to avoid.
 *
 * It still writes no framework file: `pjsip.conf`, `pjsip.endpoint.conf`,
 * `pjsip.auth.conf` and `pjsip.aor.conf` are FreePBX's, and the sanctioned way
 * to extend an endpoint is the post file, which FreePBX includes and never
 * regenerates.
 */
export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;

  const body = await req.json().catch(() => ({}));
  if (!body.id) return badRequest("id is required");

  const ext = db
    .prepare("SELECT * FROM freepbx_extensions WHERE id = ? AND user_id = ?")
    .get(String(body.id), user.id) as FreePBXExtension | undefined;
  if (!ext) return NextResponse.json({ error: "Extension not found" }, { status: 404 });

  const before = readWebrtcState(ext.extension_id);
  const pbxSecret = pbxSecretFor(ext.extension_id);
  const adopted = Boolean(pbxSecret) && pbxSecret !== ext.extension_secret;
  const secret = pbxSecret || ext.extension_secret || "";

  // The leftover endpoint file is removed even when there is no secret to
  // repair with: it is a second object with this extension's id, so it is a
  // hazard to the whole PBX, not just to this softphone.
  const removedLegacy = removeLegacyFragment(ext.extension_id);

  if (!secret) {
    const after = readWebrtcState(ext.extension_id);
    return NextResponse.json(
      {
        error: "no_secret_to_repair_with",
        reason:
          `Neither the portal nor the PBX renders a SIP secret for Ext ${ext.extension_id}, ` +
          `so there is nothing to register with.`,
        repair:
          "Create the extension's credential in FreePBX (or re-provision the extension here) " +
          "and run this again — it will adopt what the PBX renders.",
        removed_leftover_endpoint_file: removedLegacy,
        softphone: assessSoftphone(ext.extension_id, "", pbxSecret, after),
      },
      { status: 409 },
    );
  }

  // One write, in a file the portal owns, appending to an object FreePBX owns.
  const softphone = provisionWebrtc(ext.extension_id);
  // A repair also fixes the address the phone is handed, for a box that was
  // built before it was set (nothing wrote this file on older boots).
  const media = provisionMediaAddress(ext.extension_id);
  const reloaded = await reloadPjsipIfLive(
    media.written ? { ...softphone, provisioned: true } : before,
  );

  if (adopted) {
    db.prepare("UPDATE freepbx_extensions SET extension_secret = ? WHERE id = ? AND user_id = ?").run(
      secret,
      ext.id,
      user.id,
    );
  }

  const readiness = assessSoftphone(ext.extension_id, secret, pbxSecret, softphone, media.address);
  return NextResponse.json({
    success: true,
    extensionId: ext.extension_id,
    // Named rather than counted: "the secret the PBX renders was adopted" is a
    // different story from "the section was rewritten".
    adopted_pbx_secret: adopted,
    removed_leftover_endpoint_file: removedLegacy,
    reloaded_pjsip: reloaded,
    media_address_file: MEDIA_FILE,
    media_address: media.address,
    media_address_written: media.written,
    softphone: readiness,
  });
}

/**
 * The line this portal would write, for an operator who would rather do it by
 * hand. Cheap, and it is the same string the repair writes.
 */
export async function GET(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return badRequest("id query parameter is required");

  const ext = db
    .prepare("SELECT * FROM freepbx_extensions WHERE id = ? AND user_id = ?")
    .get(id, user.id) as FreePBXExtension | undefined;
  if (!ext) return NextResponse.json({ error: "Extension not found" }, { status: 404 });

  const state = readWebrtcState(ext.extension_id);
  return NextResponse.json({
    extensionId: ext.extension_id,
    file: POST_FILE,
    section: sectionHeader(ext.extension_id),
    required_section: state.requiredSection,
    provisioned: state.provisioned,
    leftover_endpoint_file: state.legacyFragment,
  });
}
