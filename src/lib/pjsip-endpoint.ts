/**
 * The portal's WebRTC endpoint fragment — and the honest answer about whether
 * anything loads it.
 *
 * `POST /api/phone/extensions` creates the extension through FreePBX and then
 * needs a softphone to be able to register against it. Until 2026-09-22 that
 * second half was one line:
 *
 *     appendFileSync("/etc/asterisk/pjsip.conf", `#include pjsip_ext_${ext}.conf`)
 *
 * and it was wrong twice over, which is why this module exists to own it:
 *
 * **1. `pjsip.conf` is not ours.** FreePBX regenerates it, so the include is
 * dropped at the next Apply Config and the fragment is left on disk entered by
 * nothing. The estate's rule is the `_custom` convention, stated in
 * `pbx/README.md` and verified live in `docs/ops-sms-trunk.md`: the
 * `*_custom*.conf` files are operator-owned and survive, the generated ones do
 * not. Every other writer follows it — `pbx/setup-cloudonix-trunk.sh`, the
 * VoIP.ms trunk include in `scripts/setup.sh`, and the vendored Teams wizard,
 * which skips its `pjsip.conf` write when `FREEPBX_MODE=true`. This module
 * follows it too: **it writes the fragment and never writes an include into a
 * file FreePBX regenerates**, whatever the fragment's fate.
 *
 * **2. FreePBX already defines `[<ext>]`.** The extension this route just
 * created has `sip` rows, and FreePBX's PJSIP driver generates an endpoint for
 * that number (`docs/legacy-voice-migration.md` reads a device secret back out
 * of the generated `pjsip.auth.conf`). Our fragment defines `[<ext>]` too, so
 * making the include *survive* would put a **duplicate object id in the same
 * load tree** — the failure `pbx/README.md` documents for `ari.conf`, where one
 * duplicate makes sorcery refuse the whole file "and costs every user". So
 * "move the include somewhere FreePBX preserves" is not the fix either, and
 * this module deliberately does not take that decision on its own.
 *
 * What it does instead is tell the operator the truth, which the old code could
 * not: whether an operator-owned file already includes the fragment
 * (`provisioned`), and, when none does, the exact line that has to be added and
 * where it may go. The portal keeps issuing the secret for the fragment to use;
 * it stops claiming the softphone works.
 *
 * Which product should own the endpoint — FreePBX's, extended from
 * `pjsip.endpoint_custom_post.conf`, or the portal's under an id FreePBX will
 * not generate — is an open decision (`docs/ava-capstone-convergence.md` §11),
 * and the measurement that decides it is `pbx/pjsip_owner_check.py --live`.
 * Until it is made, the safe state is this one: the fragment present, nothing
 * loading it.
 */
import { readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Where Asterisk's configuration lives, as the portal container sees it. */
export const DEFAULT_CONF_DIR = "/etc/asterisk";

/**
 * Files FreePBX writes and therefore rewrites. Never a target for a line we
 * own.
 *
 * Kept in step with `pbx/pjsip_owner_check.py`'s `GENERATED_NAMES`, because
 * that tool is what judges this module's output on a live box.
 */
export const FRAMEWORK_FILES = [
  "pjsip.conf",
  "pjsip.endpoint.conf",
  "pjsip.auth.conf",
  "pjsip.aor.conf",
  "pjsip_additional.conf",
] as const;

/**
 * Operator-owned include files, in the order this estate already uses them.
 *
 * `pjsip_custom_post.conf` is where the VoIP.ms trunk include and the Cloudonix
 * peer already live; `pjsip.endpoint_custom_post.conf` is FreePBX's own
 * per-endpoint custom-post file, which is what the vendored Teams wizard writes
 * when FreePBX is managing the box.
 */
export const OPERATOR_FILES = [
  "pjsip_custom_post.conf",
  "pjsip.endpoint_custom_post.conf",
  "pjsip_custom.conf",
] as const;

/** The directory to read and write. `PJSIP_CONF_DIR` overrides the default. */
export function confDir(override?: string): string {
  const chosen = override ?? process.env.PJSIP_CONF_DIR ?? DEFAULT_CONF_DIR;
  return chosen.replace(/\/+$/, "");
}

export function fragmentName(extensionId: string): string {
  return `pjsip_ext_${extensionId}.conf`;
}

export function includeLine(extensionId: string): string {
  return `#include ${fragmentName(extensionId)}`;
}

/**
 * The fragment file's contents.
 *
 * The header is a comment rather than documentation because the person who
 * finds this file on a live box is the person who needs to know it is not
 * FreePBX's — and that `[<ext>]` may collide with the endpoint FreePBX
 * generates for the same extension.
 */
export function renderFragment(extensionId: string, secret: string): string {
  return [
    "; Written by the Zeus portal (POST /api/phone/extensions) — a WebRTC",
    "; endpoint for the softphone. NOT FreePBX-managed: nothing in this file",
    "; comes from the GUI, and the generated [<ext>] in pjsip.endpoint.conf is a",
    "; different object with the same id, so only one of the two may be loaded.",
    `; See docs/ava-capstone-convergence.md §11 and pbx/pjsip_owner_check.py.`,
    "",
    `[${extensionId}](webrtc-template)`,
    `auth = ${extensionId}-auth`,
    `aors = ${extensionId}-aor`,
    "",
    `[${extensionId}-auth]`,
    "type = auth",
    "auth_type = userpass",
    `password = ${secret}`,
    `username = ${extensionId}`,
    "",
    `[${extensionId}-aor]`,
    "type = aor",
    "max_contacts = 5",
    "",
  ].join("\n");
}

/** A file that carries our `#include`, and whether it is ours to rely on. */
export interface IncludeHome {
  file: string;
  /** True when the file is operator-owned, so the include survives Apply Config. */
  operatorOwned: boolean;
}

function isFrameworkFile(file: string): boolean {
  return (FRAMEWORK_FILES as readonly string[]).includes(file);
}

/**
 * Every `*.conf` in the directory that includes our fragment.
 *
 * Derived from the directory rather than from a list of files this module
 * expects: a deployment that includes the fragment from some fourth file is
 * exactly the case that must not read as "not provisioned", and a scan of a
 * few hundred small files is cheaper than getting that wrong.
 *
 * A missing or unreadable directory is reported as "no includes" by the caller
 * via `provisioned: false` — an unreadable config dir is not a provisioned
 * softphone.
 */
export function findIncludes(extensionId: string, dir = confDir()): IncludeHome[] {
  const needle = includeLine(extensionId);
  const found: IncludeHome[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const name of entries) {
    if (!name.endsWith(".conf")) continue;
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    // Match the directive, not the bare filename: a comment mentioning the
    // fragment (this module's own docstring lands in no config file, but a
    // human's note does) is not an include.
    const included = text
      .split("\n")
      .some((line) => line.trim() === needle || line.trim() === `#tryinclude ${fragmentName(extensionId)}`);
    if (included) {
      found.push({ file: name, operatorOwned: !isFrameworkFile(name) });
    }
  }
  return found.slice().sort((a, b) => Number(b.operatorOwned) - Number(a.operatorOwned) || a.file.localeCompare(b.file));
}

/** What the portal can honestly say about a softphone endpoint. */
export interface SoftphoneState {
  /** An operator-owned file includes the fragment: it survives, and it loads. */
  provisioned: boolean;
  /** The fragment file this endpoint lives in, by name. */
  fragment: string;
  /** Where the fragment is currently included from, if anywhere. */
  includes: IncludeHome[];
  /** The line an operator has to add, and where it may go. */
  requiredInclude: string;
  operatorFiles: readonly string[];
  /** One sentence naming the state, for the API response and the UI. */
  reason: string;
}

function stateFor(extensionId: string, includes: IncludeHome[]): SoftphoneState {
  const operator = includes.find((entry) => entry.operatorOwned);
  const framework = includes.find((entry) => !entry.operatorOwned);
  const base = {
    fragment: fragmentName(extensionId),
    includes,
    requiredInclude: includeLine(extensionId),
    operatorFiles: OPERATOR_FILES,
  };

  if (operator) {
    return {
      ...base,
      provisioned: true,
      reason: `${operator.file} includes ${base.fragment}, so the softphone endpoint loads and survives Apply Config`,
    };
  }
  if (framework) {
    return {
      ...base,
      provisioned: false,
      reason:
        `${framework.file} includes ${base.fragment}, but FreePBX regenerates that file — the include is ` +
        `dropped at the next Apply Config, and until then it is a second [${extensionId}] beside the one ` +
        `FreePBX generates. Move the line to ${OPERATOR_FILES[0]}, or decide the endpoint's owner first ` +
        `(docs/ava-capstone-convergence.md §11).`,
    };
  }
  return {
    ...base,
    provisioned: false,
    reason:
      `${base.fragment} is written but nothing includes it, so Asterisk has no endpoint for this ` +
      `extension and the secret above cannot register. Add "${base.requiredInclude}" to ` +
      `${OPERATOR_FILES[0]} — but decide the endpoint's owner first if FreePBX already generates ` +
      `[${extensionId}] (docs/ava-capstone-convergence.md §11).`,
  };
}

/**
 * Write the fragment and report what loads it.
 *
 * Writes exactly one file, the fragment. It never edits an include into any
 * other file: the portal is not the owner of this PBX's config, and the last
 * time it acted as one it wrote into the single file FreePBX is guaranteed to
 * overwrite.
 */
export function provisionFragment(
  extensionId: string,
  secret: string,
  dir = confDir(),
): SoftphoneState {
  writeFileSync(join(dir, fragmentName(extensionId)), renderFragment(extensionId, secret), "utf8");
  return stateFor(extensionId, findIncludes(extensionId, dir));
}

/** The state without writing anything — for a read-back or a diagnostic. */
export function readFragmentState(extensionId: string, dir = confDir()): SoftphoneState {
  return stateFor(extensionId, findIncludes(extensionId, dir));
}

/**
 * Delete the fragment. Returns the includes that still name it.
 *
 * Stale includes are returned rather than removed: the ones that matter are in
 * files this module has just finished refusing to write, and silently editing
 * FreePBX's `pjsip.conf` to tidy up would be the same mistake one call later.
 * FreePBX drops that line on its own at the next Apply Config, and a dangling
 * `#include` is a log warning, not a fault.
 */
export function removeFragment(extensionId: string, dir = confDir()): IncludeHome[] {
  try {
    rmSync(join(dir, fragmentName(extensionId)), { force: true });
  } catch {
    // The fragment was already gone, or the directory is not mounted in this
    // container: either way there is nothing to delete, and the include state
    // below is what the caller reports.
  }
  return findIncludes(extensionId, dir);
}
