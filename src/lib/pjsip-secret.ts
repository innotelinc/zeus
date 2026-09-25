/**
 * The secret the PBX actually renders for an extension.
 *
 * Every registration failure this portal has produced looks the same from the
 * browser — a 401, so "Connected" and Offline in FreePBX — and has one of two
 * causes: the row holds no secret at all (an extension that arrived from the
 * legacy portal merge, or one created straight in FreePBX), or it holds a
 * secret FreePBX never rendered, because a FreePBX-created extension's
 * credential is generated *there* and copied into `pjsip.auth.conf`, not into
 * this database.
 *
 * Reading the rendered value back is how you tell those apart, and it is not a
 * new idea: `pbx/legacy_voice_migrate.py` verifies a migration by reading the
 * device secret back out of the generated `pjsip.auth.conf`, and
 * `docs/legacy-voice-migration.md` documents that as the end-to-end check.
 * This is the same read, in the portal, so the console can say which of the two
 * it is instead of printing a 401 and leaving the operator to guess.
 *
 * Reading is all it does. Nothing here writes an endpoint. The owner decision is
 * made (`docs/ava-capstone-convergence.md` §11.5): FreePBX owns `[<ext>]` and the
 * portal appends to it from `pjsip.endpoint_custom_post.conf`, which is exactly
 * why this read exists — the softphone has to register as FreePBX's object, so
 * FreePBX's rendered secret is the credential and there is no portal-issued one
 * to reconcile. Writing an endpoint here would reintroduce the duplicate id the
 * decision removes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { confDir } from "./pjsip-endpoint";

/**
 * Files that may render a `[<ext>-auth]` section, in the order they are read.
 *
 * The generated one first — it is authoritative when it exists — then the files
 * an operator may have written an endpoint into by hand. A file that does not
 * exist is skipped: on a box where the portal owns the endpoint there is no
 * generated auth section for it at all, and that is a state to report, not an
 * error.
 */
export const AUTH_FILES = [
  "pjsip.auth.conf",
  "pjsip.auth_custom.conf",
  "pjsip_custom.conf",
  "pjsip_custom_post.conf",
  "pjsip.endpoint_custom_post.conf",
] as const;

/**
 * Extension → password, as Asterisk will load it.
 *
 * A Node mirror of `parse_auth_conf` in `pbx/legacy_voice_migrate.py`, and kept
 * in step with it deliberately: the tool is what judges a migration on the live
 * box, so the portal's copy has to agree about which section is an extension's
 * credential. The section is `[<ext>-auth]` and the key is `password` or
 * `secret` — FreePBX emits `password` for PJSIP, but a hand-written endpoint may
 * use either, and reading neither would report a working endpoint as secretless.
 *
 * Comments and blank lines are skipped, a section header that is not an auth
 * object clears the section (so a later `password` in `[<ext>-aor]` cannot be
 * mistaken for the credential), and the last value for a section wins because
 * Asterisk loads the last one too.
 */
export function parseAuthSecrets(text: string): Map<string, string> {
  const secrets = new Map<string, string>();
  let section: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      const name = line.slice(1, -1);
      section = name.endsWith("-auth") ? name.slice(0, -"-auth".length) : null;
      continue;
    }
    if (section === null) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key === "password" || key === "secret") {
      secrets.set(section, line.slice(eq + 1).trim());
    }
  }
  return secrets;
}

/**
 * The secret the PBX renders for `extensionId`, or `""` when it renders none.
 *
 * `""` is a real answer — it means FreePBX has no credential for this number,
 * so no softphone can register against it until one exists — and it is kept
 * distinct from "could not read the directory at all", which is what a missing
 * config mount looks like. The caller reports them differently because the
 * repairs differ.
 */
export function pbxSecretFor(extensionId: string, dir = confDir()): string {
  for (const file of AUTH_FILES) {
    let text: string;
    try {
      text = readFileSync(join(dir, file), "utf8");
    } catch {
      continue;
    }
    const secret = parseAuthSecrets(text).get(extensionId);
    if (secret) return secret;
  }
  return "";
}
