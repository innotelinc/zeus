import { NextResponse } from "next/server";
import { requireUser, badRequest } from "@/lib/api-helpers";
import db from "@/lib/db";
import { provisionFragment, readFragmentState } from "@/lib/pjsip-endpoint";
import { pbxSecretFor } from "@/lib/pjsip-secret";
import { reloadPjsipIfLive } from "@/lib/pjsip-reload";
import { assessSoftphone } from "@/lib/extension-readiness";
import type { FreePBXExtension } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Repair an extension's softphone half.
 *
 * The console can now say *why* a phone will not register (see
 * `src/lib/extension-readiness.ts`), and two of the three answers are data, not
 * configuration: the row holds no secret, or it holds one FreePBX does not
 * render. Both are repaired the same way — adopt the secret the PBX actually
 * renders — and the third (nothing includes the fragment) is deliberately not
 * repaired here.
 *
 * **What this will not do.** It never edits an include into any file. The
 * fragment it writes defines `[<ext>]`, and for a FreePBX-created extension so
 * does `pjsip.endpoint.conf`: loading both is a duplicate object id, which
 * refuses the whole PJSIP load and costs every extension on the box. Which
 * product owns the endpoint is an open decision in this estate
 * (`docs/ava-capstone-convergence.md` §11), so the endpoint's own file is
 * written and nothing else is touched — the same line
 * `src/lib/pjsip-endpoint.ts` draws, for the same reason. The response reports
 * the include that is still missing, and the UI prints it verbatim.
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

  // Read before writing, so the reload decision is about the fragment's state
  // before this call rather than after it.
  const before = readFragmentState(ext.extension_id);
  const pbxSecret = pbxSecretFor(ext.extension_id);
  const adopted = Boolean(pbxSecret) && pbxSecret !== ext.extension_secret;
  const secret = pbxSecret || ext.extension_secret || "";

  if (!secret) {
    return NextResponse.json(
      {
        error: "no_secret_to_repair_with",
        reason:
          `Neither the portal nor the PBX renders a SIP secret for Ext ${ext.extension_id}, ` +
          `so there is nothing to register with.`,
        repair:
          "Create the extension's credential in FreePBX (or re-provision the extension here) " +
          "and run this again — it will adopt what the PBX renders.",
      },
      { status: 409 },
    );
  }

  // One write: the fragment, with the secret that will actually authenticate.
  const softphone = provisionFragment(ext.extension_id, secret);
  const reloaded = await reloadPjsipIfLive(before);

  if (adopted) {
    db.prepare("UPDATE freepbx_extensions SET extension_secret = ? WHERE id = ? AND user_id = ?").run(
      secret,
      ext.id,
      user.id,
    );
  }

  const readiness = assessSoftphone(ext.extension_id, secret, pbxSecret, softphone);
  return NextResponse.json({
    success: true,
    extensionId: ext.extension_id,
    // Named rather than counted: "the secret the PBX renders was adopted" is a
    // different story from "the fragment was rewritten".
    adopted_pbx_secret: adopted,
    reloaded_pjsip: reloaded,
    softphone: readiness,
  });
}
