/**
 * The portal's WebRTC settings for a FreePBX extension — one endpoint, one
 * owner.
 *
 * ## The decision (2026-09-25)
 *
 * A softphone needs a PJSIP endpoint with WebRTC media. This estate has two
 * ways to give it one, and `docs/voice-convergence.md` §11.5 left the
 * choice open until now:
 *
 *   * **(decided)** FreePBX owns the endpoint. The portal *extends* the endpoint
 *     FreePBX already generates for the extension, by appending
 *     `[<ext>](+)` — Asterisk's append-to-an-existing-section syntax — to
 *     `pjsip.endpoint_custom_post.conf`;
 *   * *(rejected)* the portal owns a second endpoint under an id FreePBX will
 *     not generate (`<ext>-webrtc`), which keeps the portal-issued secret.
 *
 * Three facts decided it, in order of weight:
 *
 * 1. **The rest of the PBX addresses `PJSIP/<ext>`.** Inbound routes, ring
 *    groups, voicemail and the device state this console polls
 *    (`src/lib/ami-handler.ts` maps `DeviceStateChange` for
 *    `freepbx_extensions.device_state`, and the estate's own routing docs match
 *    `PJSIP/<ext>`) all name the endpoint FreePBX generates. A second endpoint
 *    is one the PBX cannot route to and cannot report on: a softphone
 *    registered as `<ext>-webrtc` shows as Offline here for ever, and an
 *    inbound call to the extension does not ring it. That is not a tidiness
 *    argument, it is the feature not working.
 * 2. **There is no include to write.** FreePBX includes
 *    `pjsip.endpoint_custom_post.conf` itself, and never regenerates it. So the
 *    whole class of failure this module used to report — a product `#include`
 *    living in a file FreePBX rewrites, or `[<ext>]` defined twice in one load
 *    tree — stops existing rather than being managed. The extension syntax is
 *    this estate's own already: `scripts/setup.sh` writes `[<did>](+)` into the
 *    same file for the SMS-capable DIDs.
 * 3. **The credential problem has been solved.** §11.5's cost of this option was
 *    that the softphone would have to register with FreePBX's device secret,
 *    which the portal could not read. It can now: `src/lib/pjsip-secret.ts`
 *    reads the rendered secret out of `pjsip.auth.conf`, and
 *    `POST /api/phone/extensions` stores *that* as the extension's secret, so
 *    the browser is handed the value the PBX will actually accept.
 *
 * ## What this module therefore does
 *
 * `[<ext>](+)` plus the WebRTC media settings, appended to one operator-owned
 * file. Nothing else — no `[<ext>]` of its own, no auth object, no aor, no
 * `#include`. The endpoint, its credential and its address-of-record stay
 * FreePBX's, which is what makes the extension addressable by everything that
 * already addresses it.
 *
 * The old shape (`pjsip_ext_<ext>.conf`, read from wherever an operator included
 * it) is still *detected*: a box provisioned before this decision has one, it
 * defines a second `[<ext>]` beside FreePBX's, and the console reports it so the
 * repair path can remove it.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * The file the portal writes, and the one-file answer to "where may this go".
 *
 * Operator-owned: FreePBX includes it and never regenerates it, which is why
 * this is the sanctioned place to extend an endpoint (`pbx/README.md`, "Who
 * owns a PJSIP endpoint").
 */
export const POST_FILE = "pjsip.endpoint_custom_post.conf";

/**
 * Operator-owned files, in the order this estate already uses them.
 *
 * Only `POST_FILE` is written. The rest are named so a report can say where an
 * operator's own settings live without this module claiming to own them.
 */
export const OPERATOR_FILES = [
  POST_FILE,
  "pjsip_custom_post.conf",
  "pjsip_custom.conf",
] as const;

/** The directory to read and write. `PJSIP_CONF_DIR` overrides the default. */
export function confDir(override?: string): string {
  const chosen = override ?? process.env.PJSIP_CONF_DIR ?? DEFAULT_CONF_DIR;
  return chosen.replace(/\/+$/, "");
}

/** The fragment an older shape wrote. Detected, never written. */
export function legacyFragmentName(extensionId: string): string {
  return `pjsip_ext_${extensionId}.conf`;
}

/**
 * The append header for this extension's endpoint.
 *
 * `(+)` is Asterisk's "add these settings to the section that already exists",
 * which is the whole mechanism: the portal adds WebRTC media to FreePBX's
 * endpoint instead of defining a second object with the same id.
 */
export function sectionHeader(extensionId: string): string {
  return `[${extensionId}](+)`;
}

/**
 * What a WebRTC softphone needs from the endpoint, and nothing more.
 *
 * The media profile is written out long-hand rather than as Asterisk's
 * `webrtc=yes` shorthand: the shorthand is a later addition than the settings
 * it expands to, and on an older `res_pjsip` an unrecognised keyword is a
 * warning the operator has to notice, whereas these have been the definition of
 * "a WebRTC endpoint" for the whole of the 18–21 range FreePBX 17 ships.
 *
 * Deliberately absent: `password`, `username`, `aors`, `allow`. Those are
 * FreePBX's object, and writing them here would be this module deciding the
 * credential again.
 */
export const WEBRTC_MEDIA_SETTINGS = [
  ["media_encryption", "dtls"],
  ["media_encryption_optimistic", "no"],
  ["dtls_auto_generate_cert", "yes"],
  ["dtls_setup", "actpass"],
  ["dtls_verify", "fingerprint"],
  ["dtls_rekey", "0"],
  ["ice_support", "yes"],
  ["media_use_received_transport", "yes"],
  ["rtcp_mux", "yes"],
  ["use_avpf", "yes"],
  ["direct_media", "no"],
] as const;

/** The section's text, header included, ending in a newline. */
export function renderSection(extensionId: string): string {
  return [
    `; WebRTC settings for the endpoint FreePBX owns, written by the Zeus portal.`,
    `; \`${sectionHeader(extensionId)}\` APPENDS to the endpoint FreePBX generates for this`,
    `; extension in pjsip.endpoint.conf — one object, one owner, so there is no`,
    `; duplicate id and no include to write: FreePBX includes this file itself.`,
    `; Do not add \`type\`, \`auth\`, \`aors\`, \`username\` or \`password\` here; those are`,
    `; FreePBX's, and the softphone registers with the secret it renders`,
    `; (docs/voice-convergence.md §11, src/lib/pjsip-secret.ts).`,
    sectionHeader(extensionId),
    ...WEBRTC_MEDIA_SETTINGS.map(([key, value]) => `${key}=${value}`),
    "",
  ].join("\n");
}

/** One `[header]` block in a config file, with the lines it owns. */
interface Block {
  /** The header text between the brackets, before any `(...)` tail. */
  id: string;
  /** The parenthesised tail: `+` means append-to-existing, `!` a template. */
  tail: string | null;
  /** Line indexes (0-based, inclusive) belonging to this block. */
  start: number;
  end: number;
}

const HEADER_RE = /^\s*\[([^\]]+)\]\s*(?:\(([^)]*)\))?\s*(?:;.*)?$/;

/**
 * Split a config file into its blocks.
 *
 * Line-oriented, because the file is edited by appending and by cutting one
 * block out, and both are safer as text surgery than as a config round-trip:
 * everything this module does not own has to survive byte for byte.
 */
function blocksOf(text: string): Block[] {
  const lines = text.split("\n");
  // The empty string a trailing newline leaves behind is the file's
  // punctuation, not a block's last line. Letting a block claim it means a cut
  // takes the newline with it and the next write has to put one back, which is
  // how a "no-op" re-provision stops being one.
  const last = text.endsWith("\n") ? lines.length - 2 : lines.length - 1;
  const blocks: Block[] = [];
  for (let index = 0; index <= last; index += 1) {
    const match = HEADER_RE.exec(lines[index]);
    if (!match) continue;
    // A block owns the comment lines directly above its header, back to the
    // end of the previous block. Our own section explains itself there, and a
    // cut that left those lines behind would leave a growing pile of stale
    // comments where the block used to be.
    let start = index;
    while (start > 0 && /^\s*;/.test(lines[start - 1])) start -= 1;
    if (blocks.length > 0) blocks[blocks.length - 1].end = start - 1;
    blocks.push({ id: match[1].trim(), tail: match[2]?.trim() ?? null, start, end: last });
  }
  return blocks;
}

/** Is this block ours — `[<ext>](+)` for exactly this extension? */
function isOurs(block: Block, extensionId: string): boolean {
  return block.id === extensionId && block.tail === "+";
}

/** Drop one block's lines, leaving every other byte alone. */
function cutBlock(text: string, block: Block): string {
  const lines = text.split("\n");
  lines.splice(block.start, block.end - block.start + 1);
  // A blank line left where the block was reads as a stray gap; collapse the
  // one that follows a removal at the start of file too.
  if (lines[block.start] === "" && (block.start === 0 || lines[block.start - 1] === "")) {
    lines.splice(block.start, 1);
  }
  return lines.join("\n");
}

/** A file that carries our settings, and whether it is ours to rely on. */
export interface IncludeHome {
  file: string;
  /** True when the file is operator-owned, so it survives Apply Config. */
  operatorOwned: boolean;
}

/** What the portal can honestly say about a softphone endpoint. */
export interface SoftphoneState {
  /** Our `[<ext>](+)` settings are in the operator-owned file, so they load. */
  provisioned: boolean;
  /** The file those settings belong in. */
  file: string;
  /** The append header for this extension. */
  section: string;
  /** Where the settings were found, when they were found somewhere. */
  includes: IncludeHome[];
  /** The line an operator (or the repair path) has to add. */
  requiredSection: string;
  /** The old shape's `pjsip_ext_<ext>.conf`, when it is still on disk. */
  legacyFragment: boolean;
  /** One sentence naming the state, for the API response and the UI. */
  reason: string;
}

function stateFor(extensionId: string, dir: string): SoftphoneState {
  const header = sectionHeader(extensionId);
  let text = "";
  let readable = true;
  try {
    text = readFileSync(join(dir, POST_FILE), "utf8");
  } catch {
    // Absent is a real answer (nothing has been written yet); unreadable is
    // indistinguishable from it here and is reported as "not provisioned",
    // which is the safe direction — a softphone nobody can verify is not one
    // to claim is working.
    readable = false;
  }
  const mine = blocksOf(text).filter((block) => isOurs(block, extensionId));
  const includes: IncludeHome[] = mine.map(() => ({ file: POST_FILE, operatorOwned: true }));
  const legacyFragment = existsSync(join(dir, legacyFragmentName(extensionId)));
  const base = {
    file: POST_FILE,
    section: header,
    includes,
    requiredSection: header,
    legacyFragment,
  };

  if (mine.length > 0) {
    const legacyNote = legacyFragment
      ? ` The old ${legacyFragmentName(extensionId)} is still on disk and defines a second ` +
        `[${extensionId}]; remove it, or res_pjsip is loading two objects with the same id.`
      : "";
    return {
      ...base,
      provisioned: !legacyFragment,
      reason: legacyFragment
        ? `${POST_FILE} appends the WebRTC settings to FreePBX's endpoint.${legacyNote}`
        : `${POST_FILE} appends the WebRTC settings to the endpoint FreePBX generates for ` +
          `[${extensionId}], so the softphone and the PBX's own routing use the one object.`,
    };
  }

  return {
    ...base,
    provisioned: false,
    reason:
      `${POST_FILE} does not carry \`${header}\`, so Asterisk has no WebRTC endpoint for this ` +
      `extension and a browser cannot register.${readable ? "" : " (The file could not be read.)"}` +
      ` Add \`${header}\` with the media settings — the repair path does.` +
      (legacyFragment
        ? ` The old ${legacyFragmentName(extensionId)} is also still on disk.`
        : ""),
  };
}

/**
 * Write the WebRTC settings for this extension, or update them in place.
 *
 * Idempotent, and additive in the only sense that matters: our own block is
 * replaced, and every other byte of the file — the SMS DIDs block
 * `scripts/setup.sh` writes into this same file, an operator's own notes — is
 * carried over untouched. That is why the write is text surgery rather than a
 * config rewrite.
 */
export function provisionWebrtc(extensionId: string, dir = confDir()): SoftphoneState {
  const path = join(dir, POST_FILE);
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // No file yet: this write creates it.
  }

  const mine = blocksOf(text).filter((block) => isOurs(block, extensionId));
  // Cut every one of ours (a file edited by hand may have two), then append the
  // current text. Oldest-first so earlier cuts do not invalidate later indexes.
  let next = text;
  for (const block of [...mine].sort((a, b) => b.start - a.start)) {
    next = cutBlock(next, block);
  }
  const separator = next.length > 0 && !next.endsWith("\n") ? "\n" : "";
  writeFileSync(path, `${next}${separator}${renderSection(extensionId)}`, "utf8");

  return stateFor(extensionId, dir);
}

/** The state without writing anything — for a read-back or a diagnostic. */
export function readWebrtcState(extensionId: string, dir = confDir()): SoftphoneState {
  return stateFor(extensionId, dir);
}

/**
 * Remove our settings for this extension.
 *
 * Only our block. The file is shared, so the operation is "delete the lines
 * between our header and the next one", and it is reported by re-reading rather
 * than assumed.
 */
export function removeWebrtc(extensionId: string, dir = confDir()): SoftphoneState {
  const path = join(dir, POST_FILE);
  try {
    const text = readFileSync(path, "utf8");
    const mine = blocksOf(text)
      .filter((block) => isOurs(block, extensionId))
      .sort((a, b) => b.start - a.start);
    let next = text;
    for (const block of mine) next = cutBlock(next, block);
    writeFileSync(path, next, "utf8");
  } catch {
    // No file, or the directory is not mounted in this container: there is
    // nothing of ours to remove, and the state below says what is left.
  }
  return stateFor(extensionId, dir);
}

/**
 * Delete the pre-decision fragment, if a box still has one.
 *
 * Separate from `removeWebrtc` because it is the migration, not the delete: the
 * fragment is a second `[<ext>]` beside FreePBX's, so leaving it while adding
 * our append section would be the one state this whole decision exists to avoid.
 * Returns whether a file was actually removed.
 */
export function removeLegacyFragment(extensionId: string, dir = confDir()): boolean {
  const path = join(dir, legacyFragmentName(extensionId));
  if (!existsSync(path)) return false;
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}
