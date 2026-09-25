/**
 * Why a softphone will not register, in the order the causes matter.
 *
 * "Offline" in the extensions list is one word for four different problems, and
 * the one the operator reaches for first (the softphone) is almost never the
 * broken half:
 *
 *   1. **A leftover second endpoint.** A box provisioned before the endpoint
 *      decision (`docs/voice-convergence.md` §11) still has
 *      `pjsip_ext_<ext>.conf` on disk, which defines `[<ext>]` beside the
 *      endpoint FreePBX generates. If anything loads it, res_pjsip is being
 *      handed two objects with one id and may refuse the whole file; if nothing
 *      loads it, it is a trap waiting for the next operator who adds an include.
 *      This is checked first because it is the only one that can take the box's
 *      other extensions down with it.
 *   2. **No secret at all.** The portal has nothing to authenticate with — what
 *      an extension from the legacy portal merge, or one created straight in
 *      FreePBX, looks like.
 *   3. **A secret FreePBX does not render.** The row and the PBX disagree, so
 *      every REGISTER is a 401. FreePBX generates a PJSIP extension's
 *      credential itself, and since the endpoint decision the softphone is
 *      meant to use *that* one.
 *   4. **No WebRTC settings.** `[<ext>](+)` is not in
 *      `pjsip.endpoint_custom_post.conf`, so the endpoint FreePBX owns has no
 *      DTLS/ICE media and a browser cannot register against it at all.
 *
 * Pure over those observations, so the ordering can be tested without a PBX: it
 * is the ordering that decides what the operator is told to fix, and telling
 * them to fix the softphone when the secret is missing is how this screen
 * wasted a day.
 *
 * This module takes only *type* imports and is reached from a client component,
 * so it must stay free of `node:fs` — the readers live in
 * `extension-readiness-server.ts`.
 */
import type { SoftphoneState } from "./pjsip-endpoint";

export type SoftphoneReadinessState =
  | "ready"
  | "duplicate-fragment"
  | "missing-secret"
  | "stale-secret"
  | "not-loaded";

export interface SoftphoneReadiness {
  state: SoftphoneReadinessState;
  /** The portal holds a secret to register with. */
  secretPresent: boolean;
  /** The PBX renders a secret for this extension at all. */
  pbxSecretPresent: boolean;
  /** The portal's secret and the PBX's both exist and are not equal. */
  secretDiffers: boolean;
  /** The operator-owned file the WebRTC settings belong in. */
  file: string;
  /** Those settings are in it, so the endpoint FreePBX owns can do WebRTC. */
  loaded: boolean;
  /** The append header that has to be added when they are not. */
  requiredSection: string;
  /** A pre-decision `pjsip_ext_<ext>.conf` is still on disk. */
  duplicateFragment: boolean;
  /** One sentence naming the state, and the first thing to fix about it. */
  summary: string;
}

/**
 * Judge one extension.
 *
 * `state` is `readWebrtcState`'s answer; `pbxSecret` is `pbxSecretFor`'s. Both
 * are read-only observations, which is what makes this safe to call while
 * rendering a page.
 */
export function assessSoftphone(
  extensionId: string,
  portalSecret: string | null | undefined,
  pbxSecret: string,
  state: SoftphoneState,
): SoftphoneReadiness {
  const secretPresent = Boolean(portalSecret);
  const pbxSecretPresent = Boolean(pbxSecret);
  const secretDiffers = secretPresent && pbxSecretPresent && portalSecret !== pbxSecret;
  const base = {
    secretPresent,
    pbxSecretPresent,
    secretDiffers,
    file: state.file,
    loaded: state.provisioned,
    requiredSection: state.section,
    duplicateFragment: state.legacyFragment,
  };

  if (state.legacyFragment) {
    return {
      ...base,
      state: "duplicate-fragment",
      summary:
        `Left over from before the endpoint decision: pjsip_ext_${extensionId}.conf defines a ` +
        `second [${extensionId}] beside the endpoint FreePBX generates. Remove it — two objects ` +
        `with one id is what makes res_pjsip refuse a whole configuration.`,
    };
  }

  if (!secretPresent) {
    return {
      ...base,
      state: "missing-secret",
      summary: pbxSecretPresent
        ? `This extension has no SIP secret stored — the softphone cannot register. ` +
          `The PBX renders one for Ext ${extensionId}; Repair adopts it.`
        : `This extension has no SIP secret stored, and the PBX renders none for it either — ` +
          `a softphone cannot register until one exists.`,
    };
  }

  if (secretDiffers) {
    return {
      ...base,
      state: "stale-secret",
      summary:
        `The PBX renders a different secret for Ext ${extensionId} than the portal holds, ` +
        `so every registration is refused. Repair adopts the PBX's.`,
    };
  }

  if (!state.provisioned) {
    // The reader's own words already name the file and the line, and they are
    // written where that file is read, so they cannot drift from it.
    return { ...base, state: "not-loaded", summary: state.reason };
  }

  return {
    ...base,
    state: "ready",
    summary:
      `Ready: the stored secret matches the PBX's, and ${state.file} appends the WebRTC ` +
      `settings to the endpoint FreePBX generates for [${extensionId}] — one object, so ` +
      `routing, voicemail and this softphone all agree.`,
  };
}

/** An extension this module can consider offering to the softphone. */
export interface OfferableExtension {
  extension_id: string;
  /**
   * Absent means "not asked" — see `FreePBXExtension.softphone` — which is not
   * the same as "unusable", and the difference decides whether it is offered.
   */
  softphone?: SoftphoneReadiness;
}

/**
 * The extensions the softphone may be connected to.
 *
 * Only `ready` is offerable. An *undecided* one is offered: absence means no
 * reader ran, and dropping an extension from the list because nobody asked the
 * PBX is how a working phone disappears with no explanation. The connect itself
 * is checked against the registerer's own state either way
 * (`SoftphoneSection.connectExtension`), so an undecided extension fails loudly
 * at connect time rather than silently at pick time.
 */
export function connectable<T extends OfferableExtension>(extensions: T[]): T[] {
  return extensions.filter((ext) => !ext.softphone || ext.softphone.state === "ready");
}

/**
 * The extensions that cannot register, each with the reason to show for it.
 *
 * Returned rather than merely filtered out: a list that quietly omits an
 * extension reads as "it was never created", and the reason *is* the repair.
 */
export function notConnectable<T extends OfferableExtension>(
  extensions: T[],
): Array<{ extension: T; reason: string }> {
  const blocked: Array<{ extension: T; reason: string }> = [];
  for (const ext of extensions) {
    if (ext.softphone && ext.softphone.state !== "ready") {
      blocked.push({ extension: ext, reason: readinessLabel(ext.softphone) });
    }
  }
  return blocked;
}

/** The one-line state for a list row, where the full summary would not fit. */
export function readinessLabel(readiness: SoftphoneReadiness): string {
  switch (readiness.state) {
    case "ready":
      return "Softphone ready";
    case "duplicate-fragment":
      return "Leftover endpoint file — remove it";
    case "missing-secret":
      return "No SIP secret";
    case "stale-secret":
      return "Secret out of step with the PBX";
    case "not-loaded":
      return "No WebRTC settings on the endpoint";
  }
}
