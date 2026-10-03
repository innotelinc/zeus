import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO, load, transpile } from "./ts-probe.mjs";

const { summaryConfig, generateVoicemailSummary } = await load(
  transpile(["src/lib/voicemail-summary.ts"]), "voicemail-summary",
);
const config = { url: "http://gateway/v1", model: "verified-model", apiKey: "test-key" };

test("gateway defaults ignore legacy Ollama settings and require an explicit model", () => {
  assert.deepEqual(summaryConfig({ OLLAMA_URL: "http://old-host:11434", OLLAMA_MODEL: "llama3.2" }), {
    url: "http://192.168.1.71:20128/v1", model: "", apiKey: "",
  });
  assert.equal(summaryConfig({ VOICEMAIL_SUMMARY_URL: "http://gateway/v1///" }).url, "http://gateway/v1");
});

test("chat request authenticates and preserves transcript limits and summary semantics", async () => {
  const result = await generateVoicemailSummary("x".repeat(5000), config, async (url, options) => {
    assert.equal(url, "http://gateway/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer test-key");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "verified-model");
    assert.equal(body.stream, false);
    assert.equal(body.messages[0].role, "user");
    assert.ok(body.messages[0].content.endsWith("x".repeat(4000)));
    assert.ok(!body.messages[0].content.includes("x".repeat(4001)));
    return Response.json({ choices: [{ message: { content: "  Call back tomorrow.  " } }] });
  });
  assert.equal(result, "Call back tomorrow.");
});

test("missing configuration and unresolved Vault references never send requests", async () => {
  for (const invalid of [{ ...config, model: "" }, { ...config, apiKey: "" },
    { ...config, apiKey: "vault://cerulean/zeus#OMNIROUTE_API_KEY" }]) {
    await assert.rejects(generateVoicemailSummary("hello", invalid, () => {
      assert.fail("must not send a request");
    }), /Configure VOICEMAIL_SUMMARY_MODEL/);
  }
});

test("provider failures do not disclose response bodies or secrets", async () => {
  await assert.rejects(generateVoicemailSummary("hello", config,
    async () => new Response("private provider details", { status: 401 })),
  /^Error: Summary gateway returned HTTP 401\.$/);
  for (const body of [{}, { choices: [] }, { choices: [{ message: { content: " " } }] }]) {
    await assert.rejects(generateVoicemailSummary("hello", config, async () => Response.json(body)), /empty summary/);
  }
});

test("both compose modes use the shared gateway and deploy no local Ollama", () => {
  for (const file of ["docker-compose.yml", "docker-compose.full.yml"]) {
    const text = readFileSync(join(REPO, file), "utf8");
    assert.doesNotMatch(text, /ollama\/ollama|zeus-ollama|ollama-data|\n  ollama:/);
    assert.match(text, /VOICEMAIL_SUMMARY_URL[=:] ?\$\{VOICEMAIL_SUMMARY_URL:-http:\/\/192\.168\.1\.71:20128\/v1\}/);
    assert.match(text, /OMNIROUTE_API_KEY[=:] ?\$\{OMNIROUTE_API_KEY:-\}/);
  }
  const entrypoint = readFileSync(join(REPO, "docker-entrypoint.sh"), "utf8");
  assert.match(entrypoint.split('VAULT_KEYS="')[1].split('"')[0], /OMNIROUTE_API_KEY/);
  assert.match(readFileSync(join(REPO, "scripts/setup.sh"), "utf8"), /from vosk import Model, KaldiRecognizer/);
});
