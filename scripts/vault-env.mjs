#!/usr/bin/env node
/**
 * Zeus portal — Cerulean Vault (SecretOps) boot-time env resolver.
 *
 * The platform's secret store is **Cerulean Vault** (HashiCorp Vault, KV v2),
 * so `.env` values may be plain text or `vault://<mount>/<path>#<key>`
 * references — the same grammar Cerulean, Onyx, Atlas and Distro resolve. A
 * reference is resolved at container startup (docker-entrypoint.sh), before the
 * Next.js server boots, so every consumer reads the resolved value from
 * `process.env` unchanged and no application code knows about references.
 *
 * Environment contract:
 *   VAULT_ADDR           base URL, e.g. http://10.10.1.1:8200
 *   VAULT_TOKEN          this stack's path-scoped token, or
 *   VAULT_TOKEN_FILE     a file holding it (the Vault CLI's own order)
 *   VAULT_NAMESPACE      Enterprise namespaces; unused on OSS Vault
 *   VAULT_SKIP_VERIFY    "1" to accept a self-signed certificate
 *   VAULT_CACERT         CA bundle for TLS
 *
 * CLI:
 *   node scripts/vault-env.mjs KEY1 [KEY2 ...]
 *
 * For each KEY whose current value is a `vault://` reference, fetches the key
 * from Vault and prints a shell-safe `export KEY='<resolved>'` line to stdout so
 * the entrypoint can `eval` it. Plain (non-reference) values are left alone and
 * produce no output. Exits non-zero when a reference cannot be resolved, so a
 * container configured with references but no reachable Vault fails fast
 * instead of booting with a literal `vault://` value.
 *
 * A leftover `infisical://` value is refused explicitly: Infisical is retired
 * from this stack, not a fallback, and a stale reference must be moved with
 * `scripts/vault-migrate.py` rather than silently passing through as a
 * credential that looks configured and is not.
 */

import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { pathToFileURL } from "node:url";

const REF_PREFIX = "vault://";
const LEGACY_REF_PREFIX = "infisical://";
const DEFAULT_STORE = "cerulean";
const TIMEOUT_MS = 15_000;

/** Parse `vault://<mount>/<path>#<key>`; returns the parts or null.
 *
 * The `#key` fragment is required: a reference without one names a whole
 * secret, and a consumer that needs one value cannot guess which.
 */
export function parseReference(value) {
  if (typeof value !== "string" || !value.startsWith(REF_PREFIX)) return null;
  const rest = value.slice(REF_PREFIX.length);
  const hash = rest.indexOf("#");
  if (hash === -1) return null;
  const location = rest.slice(0, hash);
  const key = rest.slice(hash + 1).trim();
  const slash = location.indexOf("/");
  if (slash === -1) return null;
  const mount = location.slice(0, slash).trim();
  const path = location.slice(slash + 1).replace(/^\/+|\/+$/g, "").trim();
  if (!mount || !path || !key) return null;
  return { mount, path, key };
}

/** `<mount>/<path>#<key>` for messages, or null when not a reference. */
export function refName(value) {
  const parsed = parseReference(value);
  return parsed ? `${parsed.mount}/${parsed.path}#${parsed.key}` : null;
}

/** True for a value still carrying the retired `infisical://` scheme. */
export function isLegacyReference(value) {
  return typeof value === "string" && value.startsWith(LEGACY_REF_PREFIX);
}

/** Build the runtime config from the environment. Never logs the token. */
export function configFromEnv(env = process.env) {
  const token = readToken(env);
  const cfg = {
    addr: (env.VAULT_ADDR || "").replace(/\/+$/, ""),
    token,
    namespace: env.VAULT_NAMESPACE || "",
    skipVerify: env.VAULT_SKIP_VERIFY === "1",
    cacert: env.VAULT_CACERT || "",
    store: env.VAULT_PREFIX || DEFAULT_STORE,
  };
  cfg.enabled = Boolean(cfg.addr && cfg.token);
  return cfg;
}

/** VAULT_TOKEN, else the contents of VAULT_TOKEN_FILE — the Vault CLI's order. */
function readToken(env) {
  const direct = (env.VAULT_TOKEN || "").trim();
  if (direct) return direct;
  const file = (env.VAULT_TOKEN_FILE || "").trim();
  if (!file) return "";
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    // An unreadable token file is reported by resolveKeys as "not configured",
    // and by readSecret as a failed read — never as an empty credential.
    return "";
  }
}

/** GET a Vault path; resolves {status, body}. Rejects only on transport error. */
function vaultGet(cfg, pathname) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${cfg.addr}${pathname}`);
    const secure = url.protocol === "https:";
    const headers = { "X-Vault-Token": cfg.token, Accept: "application/json" };
    if (cfg.namespace) headers["X-Vault-Namespace"] = cfg.namespace;

    const options = { method: "GET", headers, timeout: TIMEOUT_MS };
    if (secure) {
      if (cfg.skipVerify) options.rejectUnauthorized = false;
      else if (cfg.cacert) options.ca = readFileSync(cfg.cacert);
    }

    const request = (secure ? https : http).request(url, options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body = {};
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          body = { errors: text.slice(0, 200) };
        }
        resolve({ status: res.statusCode || 0, body });
      });
    });

    request.on("timeout", () => request.destroy(new Error(`timed out after ${TIMEOUT_MS}ms`)));
    request.on("error", reject);
    request.end();
  });
}

/** Read one KV v2 secret: GET <mount>/data/<path> → data.data. */
export async function readSecret(cfg, { mount, path }, cache) {
  const id = `${mount}/${path}`;
  if (cache && cache.has(id)) return cache.get(id);

  const { status, body } = await vaultGet(cfg, `/v1/${mount}/data/${path}`);
  if (status === 404) {
    throw new Error(
      `vault: ${id} is not in ${cfg.addr} — seed this stack's secrets with ` +
        "`python3 scripts/vault-migrate.py --from-env-file .env`",
    );
  }
  if (status !== 200) {
    const detail = body && body.errors ? JSON.stringify(body.errors).slice(0, 200) : "";
    throw new Error(`vault: reading ${id} failed (HTTP ${status}) ${detail}`.trim());
  }

  const outer = body && body.data;
  if (!outer || typeof outer !== "object" || !outer.data || typeof outer.data !== "object") {
    throw new Error(
      `vault: ${mount}/ is not answering as KV v2 (the read returned no data.data nesting) — ` +
        `point VAULT_PREFIX at the KV v2 mount (Cerulean's default is \`${DEFAULT_STORE}\`)`,
    );
  }
  if (cache) cache.set(id, outer.data);
  return outer.data;
}

/** Quote a value for `eval`-able shell output: KEY='...' with ' escaped. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Resolve `vault://` references for the given keys; returns export lines. */
export async function resolveKeys(cfg, keys, env = process.env) {
  const references = keys.filter((key) => parseReference(env[key]));
  const legacy = keys.filter((key) => isLegacyReference(env[key]));

  if (legacy.length) {
    throw new Error(
      `vault: ${legacy.join(", ")} still hold an infisical:// reference — Infisical is retired. ` +
        "Move those secrets with scripts/vault-migrate.py and use vault://<mount>/<path>#<key>.",
    );
  }
  if (!references.length) return [];

  if (!cfg.enabled) {
    throw new Error(
      `vault: values reference Vault but VAULT_ADDR / VAULT_TOKEN (or VAULT_TOKEN_FILE) are not set: ` +
        `${references.join(", ")}`,
    );
  }

  // One read per path, not per key: a dozen keys in one secret is one request.
  const cache = new Map();
  const lines = [];
  for (const key of references) {
    const parsed = parseReference(env[key]);
    const secret = await readSecret(cfg, { mount: parsed.mount, path: parsed.path }, cache);
    const value = secret[parsed.key];
    if (value === undefined) {
      const present = Object.keys(secret).sort().join(", ");
      throw new Error(`vault: ${parsed.mount}/${parsed.path} has no key ${parsed.key} (present: ${present})`);
    }
    if (typeof value !== "string" || !value) {
      throw new Error(`vault: ${refName(env[key])} is empty — refusing to boot with an empty credential`);
    }
    lines.push(`export ${key}=${shellQuote(value)}`);
  }
  return lines;
}

async function main(argv = process.argv.slice(2)) {
  if (!argv.length) {
    console.error("usage: node scripts/vault-env.mjs KEY1 [KEY2 ...]");
    process.exit(2);
  }
  const cfg = configFromEnv();
  const lines = await resolveKeys(cfg, argv);
  if (lines.length) {
    console.error(
      `[zeus][vault] resolved ${lines.length} secret reference(s) from ${cfg.store}: ${argv
        .filter((key) => refName(process.env[key]))
        .join(", ")}`,
    );
    process.stdout.write(`${lines.join("\n")}\n`);
  }
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((err) => {
    console.error(`[zeus][vault] ${err.message}`);
    process.exit(1);
  });
}
