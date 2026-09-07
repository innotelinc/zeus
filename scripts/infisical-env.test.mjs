import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  refName,
  configFromEnv,
  readSecret,
  shellQuote,
  resolveKeys,
} from "./infisical-env.mjs";

test("refName parses infisical://<name>", () => {
  assert.equal(refName("infisical://VOIPMS_SIP_PASS"), "VOIPMS_SIP_PASS");
  assert.equal(refName("infisical://certs.default.1.key"), "certs.default.1.key");
  assert.equal(refName("infisical://  spaced  "), "spaced");
  assert.equal(refName("infisical://"), null);
  assert.equal(refName("plain"), null);
  assert.equal(refName(undefined), null);
  assert.equal(refName(null), null);
});

test("shellQuote emits eval-safe single-quoted values", () => {
  assert.equal(shellQuote("abc"), "'abc'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote(""), "''");
});

test("configFromEnv reads the stack contract", () => {
  const cfg = configFromEnv({
    INFISICAL_ADDR: "http://localhost:8383/",
    INFISICAL_TOKEN: "tok",
    INFISICAL_WORKSPACE_ID: "ws",
    INFISICAL_ENVIRONMENT: "prod",
  });
  assert.equal(cfg.addr, "http://localhost:8383");
  assert.equal(cfg.environment, "prod");
  assert.equal(cfg.enabled, true);
  assert.equal(configFromEnv({}).enabled, false);
  assert.equal(configFromEnv({ INFISICAL_ADDR: "x", INFISICAL_TOKEN: "t" }).enabled, false);
});

async function withStubServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("readSecret fetches and returns the secret value", async () => {
  const stub = await withStubServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer tok");
    assert.match(req.url, /\/api\/v3\/secrets\/raw\/VOIPMS_SIP_PASS/);
    assert.match(req.url, /workspaceId=ws/);
    assert.match(req.url, /environment=prod/);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ secret: { secretValue: "s3cret" } }));
  });
  try {
    const cfg = configFromEnv({
      INFISICAL_ADDR: stub.url,
      INFISICAL_TOKEN: "tok",
      INFISICAL_WORKSPACE_ID: "ws",
    });
    assert.equal(await readSecret(cfg, "VOIPMS_SIP_PASS"), "s3cret");
  } finally {
    await stub.close();
  }
});

test("readSecret rejects on HTTP error and missing secret", async () => {
  const stub = await withStubServer((req, res) => {
    if (req.url.includes("MISSING")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ secret: {} }));
    } else {
      res.statusCode = 500;
      res.end("boom");
    }
  });
  try {
    const cfg = configFromEnv({ INFISICAL_ADDR: stub.url, INFISICAL_TOKEN: "t", INFISICAL_WORKSPACE_ID: "w" });
    await assert.rejects(readSecret(cfg, "NOPE"), /HTTP 500/);
    await assert.rejects(readSecret(cfg, "MISSING"), /secret not found/);
  } finally {
    await stub.close();
  }
});

test("resolveKeys resolves refs, leaves plain values alone", async () => {
  const seen = new Map();
  const stub = await withStubServer((req, res) => {
    const name = decodeURIComponent(req.url.split("/").pop().split("?")[0]);
    seen.set(name, true);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ secret: { secretValue: `v-${name}` } }));
  });
  try {
    const cfg = configFromEnv({ INFISICAL_ADDR: stub.url, INFISICAL_TOKEN: "t", INFISICAL_WORKSPACE_ID: "w" });
    const env = {
      VOIPMS_SIP_PASS: "infisical://VOIPMS_SIP_PASS",
      FREEPBX_AMI_SECRET: "plain-secret",
      ASTERISK_AMI_SECRET: undefined,
    };
    const lines = await resolveKeys(cfg, ["VOIPMS_SIP_PASS", "FREEPBX_AMI_SECRET", "ASTERISK_AMI_SECRET"], env);
    assert.deepEqual(lines, ["export VOIPMS_SIP_PASS='v-VOIPMS_SIP_PASS'"]);
    assert.equal(seen.get("VOIPMS_SIP_PASS"), true);
    assert.equal(seen.size, 1);
  } finally {
    await stub.close();
  }
});

test("resolveKeys fails fast when refs exist but Infisical is not configured", async () => {
  const cfg = configFromEnv({});
  await assert.rejects(
    resolveKeys(cfg, ["SESSION_SECRET"], { SESSION_SECRET: "infisical://SESSION_SECRET" }),
    /INFISICAL_ADDR\/TOKEN\/WORKSPACE_ID/,
  );
  // Plain-only env with no config is a no-op, not an error.
  assert.deepEqual(
    await resolveKeys(cfg, ["SESSION_SECRET"], { SESSION_SECRET: "plain" }),
    [],
  );
});

test("resolveKeys fails when a referenced secret cannot be read", async () => {
  const stub = await withStubServer((req, res) => {
    res.statusCode = 404;
    res.end("nope");
  });
  try {
    const cfg = configFromEnv({ INFISICAL_ADDR: stub.url, INFISICAL_TOKEN: "t", INFISICAL_WORKSPACE_ID: "w" });
    await assert.rejects(
      resolveKeys(cfg, ["TURN_CREDENTIAL"], { TURN_CREDENTIAL: "infisical://TURN_CREDENTIAL" }),
      /HTTP 404/,
    );
  } finally {
    await stub.close();
  }
});
