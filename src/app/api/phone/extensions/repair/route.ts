import { NextResponse } from "next/server";
import { requireUser, badRequest } from "@/lib/api-helpers";
import db from "@/lib/db";
import { MEDIA_FILE, POST_FILE, legacyFragmentRemoval, provisionMediaAddress, provisionWebrtc, readWebrtcState, sectionHeader, type MediaAddressState, type SoftphoneState } from "@/lib/pjsip-endpoint";
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

  const pbxSecret = pbxSecretFor(ext.extension_id);
  const adopted = Boolean(pbxSecret) && pbxSecret !== ext.extension_secret;
  const secret = pbxSecret || ext.extension_secret || "";

  // The leftover endpoint file is removed even when there is no secret to
  // repair with: it is a second object with this extension's id, so it is a
  // hazard to the whole PBX, not just to this softphone. The detailed form is
  // used because a bare `false` cannot tell "nothing was there" from "it is
  // still there and this process may not unlink it" — and only the second one is
  // something the operator has to act on (src/lib/pjsip-endpoint.ts).
  const legacy = legacyFragmentRemoval(ext.extension_id);
  const removedLegacy = legacy.removed;

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
  //
  // A write that throws must NOT be swallowed into a success: the whole
  // reported symptom of the missing group-write bit was a 200 whose body
  // restated the state the repair had failed to change — "…does not carry
  // `[<ext>](+)` … Add `[<ext>](+)` … the repair path does" — which is the
  // same sentence the operator read *before* clicking Repair. Name the cause
  // and the fix instead (pbx/portal_config_access.py).
  let softphone: SoftphoneState;
  try {
    softphone = provisionWebrtc(ext.extension_id);
  } catch (e) {
    return NextResponse.json(
      {
        error: "webrtc_settings_not_writable",
        reason:
          `could not write ${POST_FILE} for Ext ${ext.extension_id}: ` +
          `${e instanceof Error ? e.message : "the write failed without a message"}`,
        repair:
          "the portal must be able to write the operator-owned PJSIP files it extends. " +
          "On the PBX run `python3 pbx/portal_config_access.py --apply` (the PBX entrypoint " +
          "and the zeus-pbx-sync timer already do): it gives those files the portal's own " +
          "primary gid. FreePBX's `fwconsole chown` leaves every file under /etc/asterisk " +
          "at 0664 asterisk:asterisk on every boot, and the portal's entrypoint drops " +
          "privileges with `su-exec`, which discards any `group_add` grant — so the group " +
          "has to be the portal's own, not the asterisk group.",
        softphone: assessSoftphone(
          ext.extension_id,
          secret,
          pbxSecret,
          readWebrtcState(ext.extension_id),
        ),
      },
      { status: 409 },
    );
  }
  // A repair also fixes the address the phone is handed, for a box that was
  // built before it was set (nothing wrote this file on older boots).
  let media: MediaAddressState;
  try {
    media = provisionMediaAddress(ext.extension_id);
  } catch (e) {
    // The WebRTC half landed, so this is a partial repair rather than a
    // failure: report it as such instead of claiming both.
    media = {
      written: false,
      file: MEDIA_FILE,
      address: "",
      reason:
        `the WebRTC settings were written, but the media address could not be: ` +
        `${e instanceof Error ? e.message : "the write failed without a message"}. ` +
        `Make ${MEDIA_FILE} group-writable by the asterisk group (pbx/portal_config_access.py).`,
    };
  }
  // Reload based on the state we just wrote, never the stale pre-repair read.
  // The previous code used `before` whenever media_address already existed;
  // that made a missing WebRTC section write successfully but skip the reload.
  const reloaded = await reloadPjsipIfLive(softphone);

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
    // Named so a half-repair is visible: the WebRTC settings landed and the
    // media address did not, which is a different story from "repair failed".
    media_address_reason: media.written ? "" : media.reason,
    // A duplicate fragment this process could not unlink is the third half-repair,
    // and the most dangerous one: two `[<ext>]` objects make res_pjsip refuse the
    // whole configuration, so the row must not read as repaired while it stands.
    // Empty when there was nothing to remove or it is gone.
    legacy_fragment_reason: legacy.present && !legacy.removed ? legacy.reason : "",
    legacy_fragment_path: legacy.present && !legacy.removed ? legacy.path : "",
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
