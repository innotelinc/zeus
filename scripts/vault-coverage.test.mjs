/**
 * Vault references must not reach the container unresolved.
 *
 * `.env` is handed to the portal container verbatim by `env_file: .env`, so a
 * `vault://cerulean/zeus#KEY` value reaches `process.env` as a literal string
 * unless something resolves it first.
 *
 * The failure mode this guards is silent and late. A key that is a reference in
 * `.env` but resolved by neither route below arrives as the literal string
 * `vault://…`, which is non-empty — so every truthiness guard passes, the app
 * boots healthy, and health checks stay green. Nothing complains until the one
 * consumer that actually sends the value to a third party:
 *
 *   AUTHENTIK_CLIENT_SECRET=vault://cerulean/zeus#AUTHENTIK_CLIENT_SECRET
 *
 * `oidcEnabled()` sees a truthy string, so the login button renders and
 * `/authorize` succeeds (it only needs `client_id`). The user authenticates,
 * Authentik redirects back with a code, and only the token exchange — which
 * needs the secret — fails, as `invalid_client`. The symptom is a portal that
 * looks completely fine and cannot complete a single sign-in.
 *
 * There are two legitimate ways for a reference to reach a real value, and a
 * key needs at least one of them (see docs/stack.md):
 *
 *   1. `VAULT_KEYS` in `docker-entrypoint.sh`, resolved in the portal process
 *      at boot. This is the only route for a key the portal's own code reads
 *      out of `process.env` and that compose's `environment:` block does not
 *      re-declare.
 *   2. Whole-file resolution — `scripts/compose-vault.sh` resolves `.env` into
 *      `data/.env.resolved` and passes it as `--env-file`, so compose
 *      interpolates a real value for a sibling service (freepbx, coturn) that
 *      receives the key through `${KEY:-}` interpolation rather than `env_file`.
 *
 * A key in neither place is the bug, and `AUTHENTIK_CLIENT_SECRET` was in
 * neither: absent from `VAULT_KEYS` on `origin/master`, and interpolated by no
 * compose file (the portal reads it via `env_file: .env` alone). Every other
 * reference in `.env` was covered by one route or the other.
 *
 * Read off the files rather than a live container: the deployed `.env` is
 * gitignored and its container is not reachable from CI, so the declaration is
 * the thing that can be checked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { REPO } from "./ts-probe.mjs";

/** Every compose file a reference could be resolved through. */
const COMPOSE_FILES = [
  "docker-compose.yml",
  "docker-compose.full.yml",
  "docker-compose.platform.yml",
  "compose.gateway-vault.yml",
];

/** The keys `docker-entrypoint.sh` resolves from Vault at boot. */
function vaultKeysFromEntrypoint() {
  const src = readFileSync(join(REPO, "docker-entrypoint.sh"), "utf8");
  const match = src.match(/^VAULT_KEYS="([\s\S]*?)"$/m);
  assert.ok(match, "docker-entrypoint.sh no longer defines VAULT_KEYS");
  return new Set(match[1].split(/\s+/).filter(Boolean));
}

/**
 * `KEY=vault://…` assignments in an env file. Commented-out examples are
 * skipped: they document the grammar and are not read by compose.
 */
function vaultReferencesIn(file) {
  const refs = [];
  for (const line of readFileSync(join(REPO, file), "utf8").split("\n")) {
    if (line.trimStart().startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key.startsWith("vault://")) continue;
    if (value.startsWith("vault://")) refs.push(key);
  }
  return refs;
}

/** Keys a compose file interpolates as `${KEY:-}` — the whole-file route. */
function interpolatedKeys() {
  const interpolated = new Set();
  for (const file of COMPOSE_FILES) {
    const path = join(REPO, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      for (const match of line.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):-/g)) {
        interpolated.add(match[1]);
      }
    }
  }
  return interpolated;
}

/**
 * A key is safely resolved if the portal entrypoint lists it OR some compose
 * file interpolates it. Either route substitutes a real value before use.
 */
function assertResolved(key, where) {
  const viaEntrypoint = vaultKeysFromEntrypoint().has(key);
  const viaCompose = interpolatedKeys().has(key);
  assert.ok(
    viaEntrypoint || viaCompose,
    `${where} sets ${key} to a vault:// reference, but nothing resolves it: it is ` +
      `not in docker-entrypoint.sh VAULT_KEYS and no compose file interpolates it. ` +
      `The container would receive the literal "vault://…" string and fail only ` +
      `at the point of use.`,
  );
}

test("every vault:// reference in a tracked env example is resolved", () => {
  for (const file of [".env.example", ".env.docker.example"]) {
    for (const key of vaultReferencesIn(file)) {
      assertResolved(key, file);
    }
  }
});

test("the deployed .env has no reference the entrypoint would leave unresolved", () => {
  const envFile = join(REPO, ".env");
  if (!existsSync(envFile)) {
    // `.env` is gitignored, so CI has none. The tracked examples above are the
    // surface CI can check; a real deployment is covered by this same
    // assertion run against its own checkout.
    return;
  }
  const refs = vaultReferencesIn(".env");
  assert.ok(refs.length > 0, ".env has no vault:// references — has the deployment moved off Vault?");
  for (const key of refs) {
    assertResolved(key, ".env");
  }
});

test("AUTHENTIK_CLIENT_SECRET is resolved at boot", () => {
  // The specific regression: added as a vault:// reference in `.env` while
  // absent from VAULT_KEYS, which broke every Authentik sign-in with
  // `invalid_client` at the token exchange while the portal stayed healthy.
  const keys = vaultKeysFromEntrypoint();
  assert.ok(
    keys.has("AUTHENTIK_CLIENT_SECRET"),
    "AUTHENTIK_CLIENT_SECRET must be listed in docker-entrypoint.sh VAULT_KEYS",
  );
});

test("the entrypoint fails the container rather than booting unresolved", () => {
  // A reference that cannot be resolved must abort the boot. Without the `|| exit 1`
  // an empty substitution makes `eval` succeed, the container starts, and every
  // credential silently stays a `vault://` literal.
  const src = readFileSync(join(REPO, "docker-entrypoint.sh"), "utf8");
  assert.match(
    src,
    /VAULT_EXPORTS="\$\(node \/app\/scripts\/vault-env\.mjs \$VAULT_KEYS\)" \|\| exit 1/,
    "the vault resolver's exit status must be checked, or an unresolved reference boots silently",
  );
});