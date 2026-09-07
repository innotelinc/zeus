#!/usr/bin/env node
/**
 * Zeus portal — Infisical (SecretOps) boot-time env resolver.
 *
 * Mirrors the Cerulean/Onyx/zapit integration contract: .env values may be
 * plain text or `infisical://<name>` references. A reference is resolved at
 * container startup (docker-entrypoint.sh), before the Next.js server boots,
 * so every consumer reads the resolved value from `process.env` unchanged.
 *
 * Environment contract (written to .env by scripts/infisical-setup.py):
 *   INFISICAL_ADDR           base URL, default http://localhost:8383
 *   INFISICAL_TOKEN          scoped service token
 *   INFISICAL_WORKSPACE_ID   workspace (project) the token is scoped to
 *   INFISICAL_ENVIRONMENT    environment folder, default "prod"
 *
 * CLI:
 *   node scripts/infisical-env.mjs KEY1 [KEY2 ...]
 *
 * For each KEY whose current value starts with `infisical://`, fetches the
 * secret and prints a shell-safe `export KEY='<resolved>'` line to stdout so
 * the entrypoint can `eval` it. Plain (non-reference) values are left alone
 * and produce no output. Exits non-zero if a reference cannot be resolved so
 * a container configured with references but no reachable Infisical fails
 * fast instead of booting with a literal `infisical://` value.
 */

import { pathToFileURL } from "node:url";

const REF_PREFIX = "infisical://";

/** Parse `infisical://<name>`; returns the name or null. */
export function refName(value) {
  if (typeof value !== "string" || !value.startsWith(REF_PREFIX)) return null;
  const name = value.slice(REF_PREFIX.length).trim();
  return name || null;
}

/** Build the runtime config from the environment. */
export function configFromEnv(env = process.env) {
  const cfg = {
    addr: (env.INFISICAL_ADDR || "").replace(/\/+$/, ""),
    token: env.INFISICAL_TOKEN || "",
    workspaceId: env.INFISICAL_WORKSPACE_ID || "",
    environment: env.INFISICAL_ENVIRONMENT || "prod",
  };
  cfg.enabled = Boolean(cfg.addr && cfg.token && cfg.workspaceId);
  return cfg;
}

/** GET /api/v3/secrets/raw/{name} — returns the secret value. */
export async function readSecret(cfg, name) {
  const u = new URL(`${cfg.addr}/api/v3/secrets/raw/${encodeURIComponent(name)}`);
  u.searchParams.set("workspaceId", cfg.workspaceId);
  u.searchParams.set("environment", cfg.environment);
  const res = await fetch(u, {
    headers: { Authorization: `Bearer ${cfg.token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`infisical read ${name} failed (HTTP ${res.status})`);
  }
  const body = await res.json();
  const value = body && body.secret && body.secret.secretValue;
  if (value === undefined) throw new Error(`infisical secret not found: ${name}`);
  return value;
}

/** Quote a value for `eval`-able shell output: KEY='...' with ' escaped. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Resolve `infisical://` references for the given keys; returns export lines. */
export async function resolveKeys(cfg, keys, env = process.env) {
  if (!cfg.enabled) {
    const refs = keys.filter((k) => refName(env[k]));
    if (refs.length) {
      throw new Error(
        `values reference Infisical but INFISICAL_ADDR/TOKEN/WORKSPACE_ID are not configured: ${refs.join(", ")}`,
      );
    }
    return [];
  }
  const lines = [];
  for (const key of keys) {
    const raw = env[key];
    const name = refName(raw);
    if (!name) continue;
    const value = await readSecret(cfg, name);
    lines.push(`export ${key}=${shellQuote(value)}`);
  }
  return lines;
}

async function main(argv = process.argv.slice(2)) {
  if (!argv.length) {
    console.error("usage: node scripts/infisical-env.mjs KEY1 [KEY2 ...]");
    process.exit(2);
  }
  const cfg = configFromEnv();
  const lines = await resolveKeys(cfg, argv);
  if (lines.length) {
    console.error(
      `[zeus][infisical] resolved ${lines.length} secret reference(s): ${argv
        .filter((k) => refName(process.env[k]))
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
    console.error(`[zeus][infisical] ${err.message}`);
    process.exit(1);
  });
}
