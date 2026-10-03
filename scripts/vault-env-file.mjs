#!/usr/bin/env node
/**
 * Zeus — file-level Cerulean Vault (SecretOps) resolver.
 *
 * Companion to `scripts/vault-env.mjs`. That one resolves a named KEY list into
 * shell exports for the portal's `docker-entrypoint.sh`; this resolves every
 * `vault://` reference in a whole env FILE so a resolved copy can be handed to
 * `docker compose --env-file`, which is how the services that never run the
 * portal entrypoint — freepbx and coturn — receive a real value instead of a
 * literal `vault://…` string from compose interpolation.
 *
 * The same grammar and the same hard-failure rules as `vault-env.mjs`:
 *   * `KEY=vault://<mount>/<path>#<key>` → fetched and rewritten to `KEY=<value>`
 *   * `KEY=plain`                        → left untouched
 *   * a comment or malformed line        → left untouched
 *   * a leftover `infisical://` value    → hard error (Infisical is retired)
 *   * a reference that cannot be resolved→ hard error, before anything starts
 *
 * CLI:
 *   node scripts/vault-env-file.mjs [--check] [--out PATH] FILE
 *
 *   --check   resolve every reference and report; write nothing
 *   --out     write the fully resolved file here (default: stdout)
 *
 * Environment contract is `vault-env.mjs`'s: VAULT_ADDR, VAULT_TOKEN (or
 * VAULT_TOKEN_FILE), VAULT_PREFIX, VAULT_NAMESPACE, VAULT_SKIP_VERIFY,
 * VAULT_CACERT.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { configFromEnv, parseReference, readSecret, isLegacyReference } from "./vault-env.mjs";

function die(message) {
  console.error(`[zeus][vault] ${message}`);
  process.exit(1);
}

/**
 * Split `KEY=VALUE` on the first `=`; returns null for blank lines, comments,
 * and lines that are not assignments — the same shape Compose reads.
 */
export function splitEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const equals = line.indexOf("=");
  if (equals === -1) return null;
  const key = line.slice(0, equals).trim();
  if (!key || /\s/.test(key)) return null;
  return { prefix: line.slice(0, equals), raw: line.slice(equals + 1) };
}

/** Inner value, quote character and trailing comment for one raw RHS. */
export function unquote(raw) {
  const trimmed = raw.trim();
  for (const quote of ['"', "'"]) {
    if (trimmed.startsWith(quote) && trimmed.endsWith(quote) && trimmed.length >= 2) {
      return { value: trimmed.slice(1, -1), quote, comment: "" };
    }
  }
  const marker = trimmed.indexOf(" #");
  if (marker !== -1) {
    return { value: trimmed.slice(0, marker).trim(), quote: "", comment: trimmed.slice(marker) };
  }
  return { value: trimmed, quote: "", comment: "" };
}

export async function resolveFile(path, { check = false, out = null } = {}) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    die(`could not read ${path}: ${err.message}`);
  }

  const cfg = configFromEnv();
  const cache = new Map();
  const rewritten = [];
  const names = [];

  for (const line of text.split("\n")) {
    const parts = splitEnvLine(line);
    if (!parts) {
      rewritten.push(line);
      continue;
    }

    const { value, quote, comment } = unquote(parts.raw);

    if (isLegacyReference(value)) {
      die(
        `${parts.prefix.trim()} still holds an infisical:// reference — Infisical is retired. ` +
          "Move it with scripts/vault-migrate.py and use vault://<mount>/<path>#<key>.",
      );
    }

    const parsed = parseReference(value);
    if (!parsed) {
      rewritten.push(line);
      continue;
    }

    // Resolved in both modes: --check proves the reference reads back; --write
    // is the same read with the value kept.
    const secret = await readSecret(cfg, parsed, cache);
    const resolved = secret[parsed.key];
    if (resolved === undefined) {
      const present = Object.keys(secret).sort().join(", ");
      die(`${parsed.mount}/${parsed.path} has no key ${parsed.key} (present: ${present})`);
    }
    if (typeof resolved !== "string" || !resolved) {
      die(`vault://${parsed.mount}/${parsed.path}#${parsed.key} is empty — refusing to materialize`);
    }

    names.push(parts.prefix.trim());
    rewritten.push(check ? line : `${parts.prefix}=${quote}${resolved}${quote}${comment}`);
  }

  if (!names.length) {
    if (!check) {
      if (out) writeFileSync(out, rewritten.join("\n"), { mode: 0o600 });
      else process.stdout.write(rewritten.join("\n"));
    }
    console.error(`[zeus][vault] ${path}: no vault:// references`);
    return { count: 0, names };
  }

  if (!check) {
    if (out) writeFileSync(out, rewritten.join("\n"), { mode: 0o600 });
    else process.stdout.write(rewritten.join("\n"));
  }
  console.error(
    `[zeus][vault] ${path}: ${check ? "resolve" : "resolved"} ${names.length} reference(s)` +
      (out && !check ? ` → ${out}` : ""),
  );
  return { count: names.length, names };
}

async function main(argv) {
  let check = false;
  let out = null;
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--check") check = true;
    else if (argv[i] === "--out") out = argv[++i];
    else positional.push(argv[i]);
  }
  if (positional.length !== 1) {
    console.error("usage: node scripts/vault-env-file.mjs [--check] [--out PATH] FILE");
    process.exit(2);
  }
  return resolveFile(positional[0], { check, out });
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main(process.argv.slice(2)).catch((err) => die(err.message));
}
