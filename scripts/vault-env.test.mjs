import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseReference,
  refName,
  isLegacyReference,
  configFromEnv,
  readSecret,
  shellQuote,
  resolveKeys,
} from "./vault-env.mjs";

const KV2 = (data) => JSON.stringify({ data: { data, metadata: { version: 1 } } });

test("parseReference parses vault://<mount>/<path>#<key>", () => {
  assert.deepEqual(parseReference("vault://cerulean/zeus#SESSION_SECRET"), {
    mount: "cerulean",
    path: "zeus",
    key: "SESSION_SECRET",
  });
  assert.deepEqual(parseReference("vault://cerulean/zeus/portal#VOIPMS_SIP_PASS"), {
    mount: "cerulean",
    path: "zeus/portal",
    key: "VOIPMS_SIP_PASS",
  });
  assert.deepEqual(parseReference("vault:// cerulean / zeus # TURN_CREDENTIAL "), {
    mount: "cerulean",
    path: "zeus",
    key: "TURN_CREDENTIAL",
  });
  // The #key fragment is required, and both mount and path must be present.
  assert.equal(parseReference("vault://cerulean/zeus"), null);
  assert.equal(parseReference("vault://zeus#KEY"), null);
  assert.equal(parseReference("vault://cerulean/#KEY"), null);
  assert.equal(parseReference("vault://cerulean/zeus#"), null);
  assert.equal(parseReference("infisical://SESSION_SECRET"), null);
  assert.equal(parseReference("plain"), null);
  assert.equal(parseReference(undefined), null);
  assert.equal(parseReference(null), null);
});

test("refName names the path and key for messages", () => {
  assert.equal(refName("vault://cerulean/zeus#SESSION_SECRET"), "cerulean/zeus#SESSION_SECRET");
  assert.equal(refName("plain"), null);
});

test("isLegacyReference flags the retired scheme", () => {
  assert.equal(isLegacyReference("infisical://SESSION_SECRET"), true);
  assert.equal(isLegacyReference("vault://cerulean/zeus#SESSION_SECRET"), false);
  assert.equal(isLegacyReference("plain"), false);
  assert.equal(isLegacyReference(undefined), false);
});

test("shellQuote emits eval-safe single-quoted values", () => {
  assert.equal(shellQuote("abc"), "'abc'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote(""), "''");
});

test("configFromEnv reads the stack contract", (t) => {
  const cfg = configFromEnv({
    VAULT_ADDR: "http://10.10.1.1:8200/",
    VAULT_TOKEN: "tok",
    VAULT_NAMESPACE: "team-a",
    VAULT_PREFIX: "cerulean",
  });
  assert.equal(cfg.addr, "http://10.10.1.1:8200");
  assert.equal(cfg.namespace, "team-a");
  assert.equal(cfg.store, "cerulean");
  assert.equal(cfg.enabled, true);
  assert.equal(configFromEnv({}).enabled, false);
  // A token alone is not enough — the address is what makes it reachable.
  assert.equal(configFromEnv({ VAULT_ADDR: "x" }).enabled, false);

  // VAULT_TOKEN_FILE is the fallback the Vault CLI uses.
  const dir = mkdtempSync(join(tmpdir(), "zeus-vault-"));
  const tokenFile = join(dir, "zeus.token");
  writeFileSync(tokenFile, "file-token\n");
  const fromFile = configFromEnv({ VAULT_ADDR: "http://v:8200", VAULT_TOKEN_FILE: tokenFile });
  assert.equal(fromFile.token, "file-token");
  assert.equal(fromFile.enabled, true);
  // An unreadable token file must not masquerade as a configured store.
  assert.equal(configFromEnv({ VAULT_ADDR: "http://v:8200", VAULT_TOKEN_FILE: "/nope" }).enabled, false);
  t.diagnostic(`token file fixtures under ${dir}`);
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

test("readSecret walks the KV v2 envelope", async () => {
  const stub = await withStubServer((req, res) => {
    assert.equal(req.headers["x-vault-token"], "tok");
    assert.match(req.url, /^\/v1\/cerulean\/data\/zeus(\?|$)/);
    res.setHeader("Content-Type", "application/json");
    res.end(KV2({ SESSION_SECRET: "s3cret" }));
  });
  try {
    const cfg = configFromEnv({ VAULT_ADDR: stub.url, VAULT_TOKEN: "tok" });
    const secret = await readSecret(cfg, { mount: "cerulean", path: "zeus" });
    assert.deepEqual(secret, { SESSION_SECRET: "s3cret" });
  } finally {
    await stub.close();
  }
});

test("readSecret sends the namespace header when set", async () => {
  const stub = await withStubServer((req, res) => {
    assert.equal(req.headers["x-vault-namespace"], "team-a");
    res.setHeader("Content-Type", "application/json");
    res.end(KV2({ K: "v" }));
  });
  try {
    const cfg = configFromEnv({ VAULT_ADDR: stub.url, VAULT_TOKEN: "t", VAULT_NAMESPACE: "team-a" });
    await readSecret(cfg, { mount: "cerulean", path: "zeus" });
  } finally {
    await stub.close();
  }
});

test("readSecret rejects on HTTP error, a missing path, and a non-KV-v2 mount", async () => {
  let mode = "boom";
  const stub = await withStubServer((req, res) => {
    if (mode === "boom") {
      res.statusCode = 500;
      res.end("boom");
      return;
    }
    if (mode === "missing") {
      res.statusCode = 404;
      res.end("nope");
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: { SESSION_SECRET: "flat-kv-v1" } }));
  });
  try {
    const cfg = configFromEnv({ VAULT_ADDR: stub.url, VAULT_TOKEN: "t" });
    await assert.rejects(readSecret(cfg, { mount: "cerulean", path: "zeus" }), /HTTP 500/);

    mode = "missing";
    await assert.rejects(readSecret(cfg, { mount: "cerulean", path: "zeus" }), /is not in .*vault-migrate/s);

    mode = "v1";
    await assert.rejects(readSecret(cfg, { mount: "cerulean", path: "zeus" }), /not answering as KV v2/);
  } finally {
    await stub.close();
  }
});

test("readSecret reads each path once per resolve", async () => {
  let hits = 0;
  const stub = await withStubServer((req, res) => {
    hits += 1;
    res.setHeader("Content-Type", "application/json");
    res.end(KV2({ VOIPMS_SIP_PASS: "p", VOIPMS_IAX_PASS: "q" }));
  });
  try {
    const cfg = configFromEnv({ VAULT_ADDR: stub.url, VAULT_TOKEN: "t" });
    const cache = new Map();
    await readSecret(cfg, { mount: "cerulean", path: "zeus" }, cache);
    await readSecret(cfg, { mount: "cerulean", path: "zeus" }, cache);
    assert.equal(hits, 1);
  } finally {
    await stub.close();
  }
});

test("resolveKeys resolves refs, leaves plain values alone, reads each path once", async () => {
  let hits = 0;
  const stub = await withStubServer((req, res) => {
    hits += 1;
    res.setHeader("Content-Type", "application/json");
    res.end(KV2({ VOIPMS_SIP_PASS: "v-VOIPMS_SIP_PASS", TURN_CREDENTIAL: "v-TURN" }));
  });
  try {
    const cfg = configFromEnv({ VAULT_ADDR: stub.url, VAULT_TOKEN: "t" });
    const env = {
      VOIPMS_SIP_PASS: "vault://cerulean/zeus#VOIPMS_SIP_PASS",
      TURN_CREDENTIAL: "vault://cerulean/zeus#TURN_CREDENTIAL",
      FREEPBX_AMI_SECRET: "plain-secret",
      ASTERISK_AMI_SECRET: undefined,
    };
    const lines = await resolveKeys(
      cfg,
      ["VOIPMS_SIP_PASS", "TURN_CREDENTIAL", "FREEPBX_AMI_SECRET", "ASTERISK_AMI_SECRET"],
      env,
    );
    assert.deepEqual(lines, [
      "export VOIPMS_SIP_PASS='v-VOIPMS_SIP_PASS'",
      "export TURN_CREDENTIAL='v-TURN'",
    ]);
    // Two references, one secret, one request.
    assert.equal(hits, 1);
  } finally {
    await stub.close();
  }
});

test("resolveKeys fails fast when refs exist but Vault is not configured", async () => {
  const cfg = configFromEnv({});
  await assert.rejects(
    resolveKeys(cfg, ["SESSION_SECRET"], { SESSION_SECRET: "vault://cerulean/zeus#SESSION_SECRET" }),
    /VAULT_ADDR \/ VAULT_TOKEN/,
  );
  // Plain-only env with no config is a no-op, not an error.
  assert.deepEqual(await resolveKeys(cfg, ["SESSION_SECRET"], { SESSION_SECRET: "plain" }), []);
});

test("resolveKeys refuses a retired infisical:// reference", async () => {
  const cfg = configFromEnv({ VAULT_ADDR: "http://v:8200", VAULT_TOKEN: "t" });
  await assert.rejects(
    resolveKeys(cfg, ["SESSION_SECRET"], { SESSION_SECRET: "infisical://SESSION_SECRET" }),
    /Infisical is retired/,
  );
});

test("resolveKeys refuses a missing key and an empty value", async () => {
  let payload = { OTHER_KEY: "x" };
  const stub = await withStubServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(KV2(payload));
  });
  try {
    const cfg = configFromEnv({ VAULT_ADDR: stub.url, VAULT_TOKEN: "t" });
    await assert.rejects(
      resolveKeys(cfg, ["SESSION_SECRET"], { SESSION_SECRET: "vault://cerulean/zeus#SESSION_SECRET" }),
      /has no key SESSION_SECRET \(present: OTHER_KEY\)/,
    );

    payload = { SESSION_SECRET: "" };
    await assert.rejects(
      resolveKeys(cfg, ["SESSION_SECRET"], { SESSION_SECRET: "vault://cerulean/zeus#SESSION_SECRET" }),
      /empty — refusing to boot with an empty credential/,
    );
  } finally {
    await stub.close();
  }
});

test("resolveKeys surfaces an unreachable Vault", async () => {
  // Port 1 is reserved and never listening.
  const cfg = configFromEnv({ VAULT_ADDR: "http://127.0.0.1:1", VAULT_TOKEN: "t" });
  await assert.rejects(
    resolveKeys(cfg, ["SESSION_SECRET"], { SESSION_SECRET: "vault://cerulean/zeus#SESSION_SECRET" }),
    /ECONNREFUSED|connect/i,
  );
});
