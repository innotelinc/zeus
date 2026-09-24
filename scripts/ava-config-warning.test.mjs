/**
 * The boot-time line that says the voice engine has no credential.
 *
 * The Voice screens are gated on `avaConfigured()`, which reads *this
 * process's* environment — and compose reads `env_file` when it **creates** a
 * container. So the failure this pins is the one that has no symptom of its
 * own: `AVA_ADMIN_PASSWORD` is in `.env`, the running portal cannot see it, the
 * screen renders in its "not configured" wording, and the obvious repair
 * (`docker compose restart`) cannot work. `src/instrumentation.ts` logs
 * `avaConfigurationWarning()` at boot so the state is announced rather than
 * discovered.
 *
 * What is asserted here is the message's *contract*, because a warning that
 * gets the reason wrong sends the operator to the wrong fix:
 *
 *   1. Nothing to say when a credential is present — a pre-minted
 *      AVA_ADMIN_TOKEN counts, so a token-only deployment is not nagged.
 *   2. Otherwise it names the variables it looked at, says what the screens
 *      will do, and names the repair that works (recreate, not restart).
 *   3. The warning and the screen's gate agree. If `avaConfigured()` ever
 *      returns true while this returns a warning, the log contradicts the UI.
 *
 * The module reads the environment at import time, so each case loads a fresh
 * copy with the environment it is testing (ts-probe transpiles to a new path
 * per call, and a new path is a new module instance).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { load, transpile } from "./ts-probe.mjs";

const AVA = ["src/lib/ava.ts"];

/** Load src/lib/ava.ts with exactly these credentials in the environment. */
async function loadAva({ password, token } = {}) {
  const saved = {
    AVA_ADMIN_PASSWORD: process.env.AVA_ADMIN_PASSWORD,
    AVA_ADMIN_TOKEN: process.env.AVA_ADMIN_TOKEN,
  };
  if (password === undefined) delete process.env.AVA_ADMIN_PASSWORD;
  else process.env.AVA_ADMIN_PASSWORD = password;
  if (token === undefined) delete process.env.AVA_ADMIN_TOKEN;
  else process.env.AVA_ADMIN_TOKEN = token;
  try {
    const dir = transpile(AVA);
    return await load(dir, "ava");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("the AVA configuration warning", () => {
  it("is silent for a password, and for a pre-minted token on its own", async () => {
    assert.equal((await loadAva({ password: "rotated" })).avaConfigurationWarning(), null);
    assert.equal((await loadAva({ token: "jwt" })).avaConfigurationWarning(), null);
  });

  it("names the variables, the screen's wording, and the repair that works", async () => {
    const ava = await loadAva();
    const warning = ava.avaConfigurationWarning();

    assert.ok(warning, "expected a warning with no credential in the environment");
    assert.match(warning, /AVA_ADMIN_PASSWORD/);
    assert.match(warning, /AVA_ADMIN_TOKEN/);
    assert.match(warning, /not configured/); // the state the screens will render
    assert.match(warning, /recreate/i);
    // The repair is the opposite of a restart, so a bare "restart" must not be
    // what the line recommends.
    assert.doesNotMatch(warning, /restart the (portal|container)\b/i);
  });

  it("agrees with the gate the Voice screens use", async () => {
    const unconfigured = await loadAva();
    assert.equal(unconfigured.avaConfigured(), false);
    assert.notEqual(unconfigured.avaConfigurationWarning(), null);

    const configured = await loadAva({ password: "rotated" });
    assert.equal(configured.avaConfigured(), true);
    assert.equal(configured.avaConfigurationWarning(), null);
  });
});
