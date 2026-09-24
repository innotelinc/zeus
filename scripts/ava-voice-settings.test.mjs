/**
 * The voice settings the engine loaded, as `/dashboard/health` reports them.
 *
 * Two things are pinned here, and they fail in different ways.
 *
 * **The parsing** (`src/lib/ava-voice-settings.ts`) reads the engine's
 * Prometheus exposition and `/health` pipelines into one line. The failure it
 * can have is a quiet one: a metric that is never matched, or an "unknown"
 * value rendered as a real setting, tells an operator the agent's barge-in
 * windows are something they are not — the same class of mistake as reading a
 * `/v1/models` listing as a model check (docs/ava-integration.md). So the cases
 * below are: a comment/blank/garbage body, the labelled and bare samples, the
 * `+Inf` a histogram can legally export, a partial set, and the honest empty
 * state (an engine that has not published its gauges yet — they are exported at
 * the first call since the process started).
 *
 * **The card actually renders.** `/api/health` destructures its probe array by
 * position and the dashboard iterates `serviceMeta`, so a new service has three
 * places to be named and *no* error if it is named in only two: the probe
 * result is dropped from the object, or the card silently does not render. That
 * is asserted by reading both sources rather than by rendering (there is no JSX
 * runner here), the way `scripts/addon-gate-copy.test.mjs` holds a JSX
 * contract.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { load, transpile } from "./ts-probe.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(REPO, rel), "utf8");

const SERVICE = "ava_voice_settings";
const ROUTE = "src/app/api/health/route.ts";
const PAGE = "src/app/dashboard/health/page.tsx";

const { parseSamples, bargeInSummary, ttsSummary, voiceSettingsDetail } = await load(
  transpile(["src/lib/ava-voice-settings.ts"]),
  "ava-voice-settings",
);

const ALL_WINDOWS = [
  "# HELP ai_agent_config_barge_in_ms Configured barge-in timing values (ms)",
  "# TYPE ai_agent_config_barge_in_ms gauge",
  'ai_agent_config_barge_in_ms{param="initial_protection_ms"} 200.0',
  'ai_agent_config_barge_in_ms{param="min_ms"} 250.0',
  'ai_agent_config_barge_in_ms{param="post_tts_end_protection_ms"} 250.0',
  'ai_agent_config_barge_in_ms{param="greeting_protection_ms"} 0.0',
  "# TYPE ai_agent_config_barge_in_threshold gauge",
  "ai_agent_config_barge_in_threshold 1000.0",
].join("\n");

describe("reading the engine's exposition", () => {
  it("keeps labelled and bare samples apart, and drops what is not a setting", () => {
    const samples = parseSamples(
      [
        "# a comment line",
        "",
        'ai_agent_config_barge_in_ms{param="min_ms"} 250.0',
        "ai_agent_config_barge_in_threshold 1000.0",
        "ai_agent_histogram_bucket{le=\"+Inf\"} +Inf",
        "ai_agent_histogram_bucket{le=\"1.0\"} 3.0",
        "not a sample at all",
      ].join("\n"),
    );

    assert.equal(samples.get('ai_agent_config_barge_in_ms{param="min_ms"}'), 250);
    // The bare gauge is a different key from any labelled series of the same
    // family, which is what stops a threshold being read as a window.
    assert.equal(samples.get("ai_agent_config_barge_in_threshold"), 1000);
    assert.equal(samples.get('ai_agent_histogram_bucket{le="1.0"}'), 3);
    // `+Inf` is legal exposition and is not a configured value.
    assert.equal(samples.has('ai_agent_histogram_bucket{le="+Inf"}'), false);
    assert.equal(samples.size, 3);
  });

  it("names every barge-in window the engine loaded", () => {
    const summary = bargeInSummary(ALL_WINDOWS);
    assert.match(summary, /start-of-TTS guard 200ms/);
    assert.match(summary, /min talk 250ms/);
    assert.match(summary, /post-TTS guard 250ms/);
    assert.match(summary, /greeting guard 0ms/);
    assert.match(summary, /threshold 1000/);
  });

  it("reports only what was published, and null when nothing was", () => {
    const partial = bargeInSummary('ai_agent_config_barge_in_ms{param="min_ms"} 300.0');
    assert.match(partial, /min talk 300ms/);
    assert.doesNotMatch(partial, /threshold/);
    // The engine exports these at its first call, so an empty body is the
    // normal state of a just-restarted engine — never a fabricated zero.
    assert.equal(bargeInSummary(""), null);
    assert.equal(bargeInSummary("# HELP nothing\n"), null);
  });
});

describe("naming the TTS the engine will speak with", () => {
  it("lists the provider each pipeline resolves", () => {
    const summary = ttsSummary({ zeus_hybrid: { tts: "local_tts" }, zeus_premium: { tts: "elevenlabs_tts" } });
    assert.match(summary, /zeus_hybrid=local_tts/);
    assert.match(summary, /zeus_premium=elevenlabs_tts/);
  });

  it("names the stack's own selection only when this process holds it", () => {
    // The portal cannot see the local-ai-server's environment, so without the
    // variable it says nothing about the backend rather than guessing.
    assert.equal(ttsSummary(null), null);
    assert.match(ttsSummary(null, { backend: "kokoro", voice: "af_heart" }), /kokoro\/af_heart/);
    assert.match(ttsSummary(null, { backend: "kokoro" }), /stack selects kokoro$/);
  });

  it("ignores a pipeline whose tts is not a provider name", () => {
    assert.equal(ttsSummary({ broken: { tts: { nested: true } } }), null);
  });
});

describe("the line the health card shows", () => {
  it("is never empty, and says which half could not be read", () => {
    const detail = voiceSettingsDetail("", null);
    assert.match(detail, /barge-in: not published yet/);
    assert.match(detail, /first call since it started/);
  });

  it("carries both halves when both are available", () => {
    const detail = voiceSettingsDetail(ALL_WINDOWS, { zeus_hybrid: { tts: "local_tts" } }, {
      backend: "kokoro",
      voice: "af_heart",
    });
    assert.match(detail, /start-of-TTS guard 200ms/);
    assert.match(detail, /TTS zeus_hybrid=local_tts/);
    assert.match(detail, /stack selects kokoro\/af_heart/);
  });
});

// ── the card has three places to be named, and no error if it is not ─────────
function blockFrom(source, start) {
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces");
}

function block(source, marker) {
  const at = source.indexOf(marker);
  assert.notEqual(at, -1, `expected the source to contain ${JSON.stringify(marker)}`);
  return blockFrom(source, at);
}

const keysOf = (text, pattern) => [...text.matchAll(pattern)].map((m) => m[1]).sort();

describe("the health route and its card stay in lockstep", () => {
  const routeSource = read(ROUTE);
  const pageSource = read(PAGE);

  const routeServices = keysOf(
    block(routeSource, "services: {\n    database: ProbeResult;"),
    /^ {4}([a-z_]+): ProbeResult;$/gm,
  );
  const pageServices = keysOf(
    block(pageSource, "services: {\n    database: ProbeResult;"),
    /^ {4}([a-z_]+): ProbeResult;$/gm,
  );
  const metaKeys = keysOf(
    blockFrom(pageSource, pageSource.indexOf("> = {", pageSource.indexOf("serviceMeta"))),
    /^ {2}([a-z_]+): \{$/gm,
  );

  it("declares the same services in the route and the page", () => {
    assert.deepEqual(pageServices, routeServices);
  });

  it("gives every service a card, or it silently does not render", () => {
    // The page maps `Object.keys(serviceMeta)`, so a service the route reports
    // and this record omits is invisible — no error, no empty card, nothing.
    assert.deepEqual(metaKeys, routeServices);
  });

  it("reports the voice settings, and never as `down`", () => {
    assert.ok(routeServices.includes(SERVICE));
    assert.ok(metaKeys.includes(SERVICE));
    // Preferences do not take a working phone system down: the aggregate
    // counts `down`, so a settings row that could would flip the whole page.
    assert.doesNotMatch(block(routeSource, "async function probeAvaVoiceSettings"), /status: "down"/);
  });

  it("appends the probe instead of inserting it, since the array is positional", () => {
    const before = routeSource.indexOf("probeExtensionPreflight(),");
    const probe = routeSource.indexOf(`${SERVICE}: voiceSettingsResult`);
    const awaited = routeSource.indexOf("voiceSettingsResult] =");
    assert.ok(before !== -1 && probe !== -1 && awaited !== -1, "expected all three call sites");
    // The destructure names it last, and the services object binds it — a probe
    // that reports under another service's name is exactly the bug the note in
    // the route warns about.
    assert.ok(routeSource.indexOf("preflightResult, voiceSettingsResult]") !== -1);
    // lastIndexOf: the call is the *second* occurrence — the function's own
    // signature line contains the same characters.
    assert.ok(routeSource.lastIndexOf("probeAvaVoiceSettings()") > before);
    assert.match(block(routeSource, "async function probeAvaVoiceSettings"), /voiceSettingsDetail\(/);
  });
});
