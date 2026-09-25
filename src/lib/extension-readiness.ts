/**
 * Why a softphone will not register, in the order the causes matter.
 *
 * "Offline" in the extensions list is one word for three different problems,
 * and the one the operator reaches for first (the softphone) is almost never
 * the broken half:
 *
 *   1. **No secret at all.** The portal has nothing to authenticate with. This
 *      is what an extension that arrived from the legacy portal merge, or one
 *      created straight in FreePBX, looks like — `POST /api/phone/extensions`
 *      is the only writer that stores one.
 *   2. **A secret FreePBX does not render.** The row and the PBX disagree, so
 *      every REGISTER is a 401. FreePBX generates a PJSIP extension's
 *      credential itself; the portal's copy is only right when the portal
 *      created the extension.
 *   3. **Nothing loads the fragment.** `pjsip_ext_<ext>.conf` exists with the
 *      right secret and no operator-owned file includes it, so Asterisk has no
 *      endpoint for the number (`src/lib/pjsip-endpoint.ts` states the same
 *      limit, and why it does not resolve it by writing an include).
 *
 * Pure over the three observations, so the ordering can be tested without a
 * PBX: it is the ordering that decides what the operator is told to fix, and
 * telling them to fix the softphone when the secret is missing is how this
 * screen wasted a day.
 */
// Type-only, and deliberately so: this module is what the extensions list
// renders, so it is reachable from a client component and must not pull
// `node:fs` into that bundle. The readers that touch the config directory live
// in `extension-readiness-server.ts`.
import type { SoftphoneState } from "./pjsip-endpoint";

export type SoftphoneReadinessState =
  | "ready"
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
  /** The fragment file that would carry this endpoint, by name. */
  fragment: string;
  /** An operator-owned file includes the fragment, so Asterisk loads it. */
  fragmentLoaded: boolean;
  /** The line that has to be added when nothing is loading the fragment. */
  requiredInclude: string;
  /** One sentence naming the state, and the first thing to fix about it. */
  summary: string;
}

/** Where an operator has to put the include, the estate's operator-owned file. */
const INCLUDE_HOME = "pjsip_custom_post.conf";

/**
 * Judge one extension.
 *
 * `fragment` is `readFragmentState`'s answer; `pbxSecret` is `pbxSecretFor`'s.
 * Both are read-only observations, which is what makes this safe to call while
 * rendering a page.
 */
export function assessSoftphone(
  extensionId: string,
  portalSecret: string | null | undefined,
  pbxSecret: string,
  fragment: SoftphoneState,
): SoftphoneReadiness {
  const secretPresent = Boolean(portalSecret);
  const pbxSecretPresent = Boolean(pbxSecret);
  const secretDiffers = secretPresent && pbxSecretPresent && portalSecret !== pbxSecret;
  const base = {
    secretPresent,
    pbxSecretPresent,
    secretDiffers,
    fragment: fragment.fragment,
    fragmentLoaded: fragment.provisioned,
    // Always populated by the fragment reader (`stateFor` sets it unconditionally).
    requiredInclude: fragment.requiredInclude,
  };

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

  if (!fragment.provisioned) {
    // The fragment's own reason already names the file and the line, and it is
    // written where that file is read, so it cannot drift from this message.
    return { ...base, state: "not-loaded", summary: fragment.reason };
  }

  const home = fragment.includes.find((entry) => entry.operatorOwned);
  return {
    ...base,
    state: "ready",
    summary:
      `Ready: the stored secret matches the PBX's and ${home?.file ?? INCLUDE_HOME} ` +
      `includes ${fragment.fragment}, so the softphone endpoint loads and survives Apply Config.`,
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
    case "missing-secret":
      return "No SIP secret";
    case "stale-secret":
      return "Secret out of step with the PBX";
    case "not-loaded":
      return "Fragment not loaded";
  }
}
