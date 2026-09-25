/**
 * Read the PBX's side and judge every extension row.
 *
 * Server-only, and split from `extension-readiness.ts` for a reason the build
 * found the hard way: the extensions list is a client component, and the pure
 * helper it imports for its labels lives in a module that must therefore be
 * free of `node:fs`. Bringing the readers along put `node:fs` into the page's
 * bundle and Turbopack refused to write the endpoint at all — a compile error
 * that only appeared at build time, since the unit tests import the same module
 * in Node, where `node:fs` exists.
 *
 * The reads are per row (`readWebrtcState` reads the post file,
 * `pbxSecretFor` reads the auth files). That is affordable for the handful of
 * extensions an account has, and it keeps the list's answer the same one the
 * repair endpoint will give — a cached copy that disagrees with the repair is
 * how an operator ends up repairing something that was already fine.
 */
import { readWebrtcState } from "./pjsip-endpoint";
import { pbxSecretFor } from "./pjsip-secret";
import { assessSoftphone, type SoftphoneReadiness } from "./extension-readiness";

/** A row this module can judge, structurally (no dependency on the row type). */
export interface SoftphoneCandidate {
  extension_id: string;
  extension_secret: string | null;
}

export function withSoftphoneReadiness<T extends SoftphoneCandidate>(
  rows: T[],
): Array<T & { softphone: SoftphoneReadiness }> {
  return rows.map((row) => ({
    ...row,
    softphone: assessSoftphone(
      row.extension_id,
      row.extension_secret,
      pbxSecretFor(row.extension_id),
      readWebrtcState(row.extension_id),
    ),
  }));
}
