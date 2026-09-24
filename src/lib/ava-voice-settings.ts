/**
 * Zeus → AVA voice settings: what the engine actually loaded, read from the
 * engine's own exposition instead of a hand-run `curl localhost:15000/metrics`.
 *
 * Two questions this answers for an operator looking at `/dashboard/health`:
 *
 *   * **How hard is the agent to interrupt?** The barge-in windows and energy
 *     threshold are the knobs that decide whether the agent cuts its own
 *     sentence short (its voice coming back off the caller's handset counting
 *     as the caller talking). The engine publishes them as Prometheus gauges —
 *     `ai_agent_config_barge_in_ms{param=…}` and
 *     `ai_agent_config_barge_in_threshold` — but only in its *aggregate*
 *     form, and only from `_export_config_metrics`, which runs **at the first
 *     call since the process started**. So "no samples yet" is a real and
 *     expected state, not an error, and it is reported as one.
 *
 *   * **Which voice is on the line?** `/health` names the TTS provider each
 *     pipeline resolves (`pipelines.<name>.tts`, e.g. `local_tts` vs
 *     `elevenlabs_tts`). The *backend* behind `local_tts` (Piper vs Kokoro)
 *     lives in the local-ai-server's environment, which the portal cannot
 *     read — so it is only named here when this process holds the same
 *     `LOCAL_TTS_BACKEND`/`LOCAL_TTS_VOICE` the compose stack was created
 *     with, and it is labelled as the stack's selection rather than the
 *     engine's.
 *
 * Pure functions, no I/O: the probe in `/api/health` fetches, this parses, and
 * `scripts/ava-voice-settings.test.mjs` pins the parsing without a network.
 */

/** One entry of the engine's `/health` `pipelines` map (only `tts` is read). */
export interface EnginePipeline {
  tts?: unknown;
  [key: string]: unknown;
}

/**
 * The gauges are Prometheus text exposition: `name value`, or
 * `name{label="x"} value`. Reduced to a map keyed by the sample's full name so
 * a labelled series and a bare one cannot collide.
 */
export function parseSamples(metrics: string): Map<string, number> {
  const samples = new Map<string, number>();
  for (const line of metrics.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+([0-9.eE+-]+)$/.exec(trimmed);
    if (!match) continue;
    const value = Number(match[3]);
    // `+Inf`/`NaN` are legal exposition values and are not settings.
    if (!Number.isFinite(value)) continue;
    samples.set(match[1] + (match[2] ?? ""), value);
  }
  return samples;
}

/** label -> how the window reads to a person who has never opened config.py. */
const BARGE_WINDOWS: ReadonlyArray<readonly [param: string, label: string]> = [
  ["initial_protection_ms", "start-of-TTS guard"],
  ["min_ms", "min talk"],
  ["post_tts_end_protection_ms", "post-TTS guard"],
  ["greeting_protection_ms", "greeting guard"],
];

/**
 * The barge-in knobs the engine published, or null when it has published none
 * (no call yet since it started). Deliberately silent about provider turn
 * detection: those gauges come from `providers.openai_realtime`, which this
 * deployment's pipelines do not use, so naming them would only ever print a
 * second "not published" line.
 */
export function bargeInSummary(metrics: string): string | null {
  const samples = parseSamples(metrics);
  const windows: string[] = [];
  for (const [param, label] of BARGE_WINDOWS) {
    const value = samples.get(`ai_agent_config_barge_in_ms{param="${param}"}`);
    if (value !== undefined) windows.push(`${label} ${value}ms`);
  }
  const threshold = samples.get("ai_agent_config_barge_in_threshold");
  if (threshold !== undefined) windows.push(`threshold ${threshold}`);
  return windows.length ? windows.join(", ") : null;
}

/** The TTS provider per pipeline, plus the stack's own selection when known. */
export function ttsSummary(
  pipelines: Record<string, EnginePipeline> | null | undefined,
  env: { backend?: string | null; voice?: string | null } = {},
): string | null {
  const parts: string[] = [];
  const engines = Object.entries(pipelines ?? {})
    .filter(([, pipeline]) => typeof pipeline?.tts === "string" && pipeline.tts)
    .map(([name, pipeline]) => `${name}=${pipeline.tts as string}`);
  if (engines.length) parts.push(`TTS ${engines.join(", ")}`);
  if (env.backend) {
    parts.push(`stack selects ${env.backend}${env.voice ? `/${env.voice}` : ""}`);
  }
  return parts.length ? parts.join(" · ") : null;
}

/**
 * The whole line the health card shows. Never empty: an engine that has not
 * published its barge-in windows yet says so, because "we could not read it"
 * and "it is not configured" are the two states an operator must be able to
 * tell apart (the same rule the Voice screens follow).
 */
export function voiceSettingsDetail(
  metrics: string,
  pipelines: Record<string, EnginePipeline> | null | undefined,
  env: { backend?: string | null; voice?: string | null } = {},
): string {
  const parts: string[] = [];
  const barge = bargeInSummary(metrics);
  parts.push(
    barge
      ? `barge-in: ${barge}`
      : "barge-in: not published yet — the engine exports its loaded windows at the first call since it started",
  );
  const tts = ttsSummary(pipelines, env);
  if (tts) parts.push(tts);
  return parts.join(" · ");
}
