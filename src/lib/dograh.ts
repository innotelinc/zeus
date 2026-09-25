/**
 * Zeus → Dograh client.
 *
 * Dograh is the voice plane: it answers calls, runs the interview workflows,
 * and owns the transcripts and recordings. There is exactly one such engine —
 * this module replaced `lib/ava.ts`, and the reason it is a whole file rather
 * than a few fetches is that the screens behind it need one vocabulary for
 * "the engine said this", "the engine is not configured" and "the engine is
 * down", and those three must never render the same way.
 *
 * Env:
 *   DOGRAH_API_URL  — Dograh API base. Default `http://127.0.0.1:8000`, which
 *                     is where `dograh-api` binds in the full stack (it runs
 *                     `network_mode: host`, so the portal reaches it on
 *                     loopback). Override for a split deployment.
 *   DOGRAH_API_KEY  — sent as `X-API-Key`. Empty → standalone mode: the voice
 *                     screens report "not configured" instead of failing, the
 *                     same contract `avaConfigured()` had.
 *   DOGRAH_UI_URL   — the Dograh UI, for links out. Default
 *                     `http://127.0.0.1:3010`.
 *
 * Failure policy mirrors `lib/magnate.ts` and the old `lib/ava.ts`: an
 * unreachable or misconfigured engine is a typed state, never a throw and
 * never a silently empty list. An operator has to be able to tell "no calls"
 * from "no engine".
 *
 * ## Why the API and not the database
 *
 * The portal reads some products by database (`avantfax.ts`) because nothing
 * else is exposed. Dograh publishes a supported HTTP API with a service key,
 * so this is the interface that survives a Dograh upgrade — reading its
 * Postgres would couple the portal to a schema it does not own.
 */
import { z } from "zod";

const DOGRAH_BASE = (process.env.DOGRAH_API_URL ?? "http://127.0.0.1:8000")
  .trim()
  .replace(/\/+$/, "");

const DOGRAH_KEY = (process.env.DOGRAH_API_KEY ?? "").trim();

const DOGRAH_UI = (process.env.DOGRAH_UI_URL ?? "http://127.0.0.1:3010")
  .trim()
  .replace(/\/+$/, "");

/** How long a single Dograh request may take before it is treated as down. */
const TIMEOUT_MS = 6_000;

export function dograhConfigured(): boolean {
  return Boolean(DOGRAH_KEY);
}

/**
 * Where the portal talks to Dograh. Exported so `/api/health` names the same
 * address the screens use, instead of a second reading of the same variable
 * that can drift from it.
 */
export function dograhApiBase(): string {
  return DOGRAH_BASE;
}

/**
 * The Dograh UI's base, for links that leave this console.
 *
 * A link to an address only the portal can reach would look broken to the
 * operator clicking it, so callers should prefer a browser-reachable host —
 * see `dograhUiUrl()`, which the console uses.
 */
export function dograhUiBase(): string {
  return DOGRAH_UI;
}

/**
 * What to log at startup when the voice engine is not configured, or null.
 *
 * The same trap the AVA version documented holds here: Compose reads `env_file`
 * when it **creates** a container, so a portal created before `DOGRAH_API_KEY`
 * was added to `.env` has the value on disk and not in its process. The only
 * symptom is an empty Voice screen, whose most obvious repair (`docker compose
 * restart`) cannot work. The boot log is where that gets said.
 */
export function dograhConfigurationWarning(): string | null {
  if (dograhConfigured()) return null;
  return (
    "the voice engine is not configured in this process: DOGRAH_API_KEY is " +
    "unset, so the Voice screens will report it as not configured. Set the key " +
    "in .env and RECREATE the portal — env_file is read at container CREATE " +
    "time, so a restart reuses the environment the container already has."
  );
}

export type DograhState = "ok" | "unreachable" | "unauthorized" | "not_configured";

export type DograhResult<T> =
  | { state: "ok"; data: T }
  | { state: Exclude<DograhState, "ok">; error: string; data: null };

function failure<T>(state: Exclude<DograhState, "ok">, error: string): DograhResult<T> {
  return { state, error, data: null };
}

const NOT_CONFIGURED =
  "the voice engine is not configured: DOGRAH_API_KEY is unset in this process";

/**
 * One authenticated request.
 *
 * Three outcomes are kept distinct because each sends an operator somewhere
 * different: `not_configured` is a deployment change, `unauthorized` is a key
 * that needs rotating or a service key that was never registered, and
 * `unreachable` is Dograh itself. Collapsing them into one "error" is how a
 * misconfiguration comes to be read as an outage.
 */
async function request<T>(
  path: string,
  parse: (body: unknown) => T,
): Promise<DograhResult<T>> {
  if (!dograhConfigured()) return failure("not_configured", NOT_CONFIGURED);

  let resp: Response;
  try {
    resp = await fetch(`${DOGRAH_BASE}${path}`, {
      headers: { "X-API-Key": DOGRAH_KEY, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure("unreachable", `could not reach the voice engine at ${DOGRAH_BASE}: ${message}`);
  }

  if (resp.status === 401 || resp.status === 403) {
    return failure(
      "unauthorized",
      `the voice engine rejected the service key (HTTP ${resp.status})`,
    );
  }
  if (!resp.ok) {
    return failure("unreachable", `the voice engine answered HTTP ${resp.status}`);
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    return failure("unreachable", "the voice engine sent a response that is not JSON");
  }

  try {
    return { state: "ok", data: parse(body) };
  } catch (error) {
    // A shape change is not an outage, but it is not usable data either, and
    // guessing at it would put a wrong number on a screen. Say so.
    const message = error instanceof Error ? error.message : String(error);
    return failure("unreachable", `the voice engine's response did not match the expected shape: ${message}`);
  }
}

// ── workflows ───────────────────────────────────────────────────────
// A "workflow" is what the dialplan calls an agent: the interview flow, its
// voice, its prompt. `/dashboard/voice` lists them and names each bound DID's
// target from them, so an operator never has to match a bare extension number
// against a UI in another product.

const workflowSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  created_at: z.string().nullable().optional(),
  total_runs: z.number().nullable().optional(),
  workflow_uuid: z.string().nullable().optional(),
  folder_id: z.number().nullable().optional(),
});

export type DograhWorkflow = z.infer<typeof workflowSchema>;

const workflowListSchema = z.array(workflowSchema);

/**
 * How much of the estate has an agent.
 *
 * The count endpoint is separate from the list because the Voice screen's
 * summary should not depend on successfully parsing twelve workflow bodies —
 * a single malformed workflow should not blank the whole page.
 */
const countSchema = z.object({
  total: z.number(),
  active: z.number(),
  archived: z.number(),
});

export interface DograhWorkflowCount {
  total: number;
  active: number;
  archived: number;
}

export function listWorkflows(status?: "active" | "archived"): Promise<DograhResult<DograhWorkflow[]>> {
  const query = status ? `?status=${status}` : "";
  return request(`/api/v1/workflow/fetch${query}`, (body) => workflowListSchema.parse(body));
}

export function countWorkflows(): Promise<DograhResult<DograhWorkflowCount>> {
  return request("/api/v1/workflow/count", (body) => countSchema.parse(body));
}

/**
 * The per-workflow tuning that decides how quickly the agent stops talking.
 *
 * These four fields are the whole of the interruption behaviour, and they are
 * the reason this screen exists at all: every workflow shipped with an empty
 * configuration and therefore fell back to a plain speech timeout, which is
 * what made the agent feel like it talked over the caller.
 */
const workflowConfigSchema = z
  .object({
    turn_stop_strategy: z.string().nullable().optional(),
    smart_turn_stop_secs: z.number().nullable().optional(),
    turn_start_strategy: z.string().nullable().optional(),
    provisional_vad_pause_secs: z.number().nullable().optional(),
    max_call_duration: z.number().nullable().optional(),
  })
  .passthrough();

export type DograhTurnConfig = z.infer<typeof workflowConfigSchema>;

const workflowDetailSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  workflow_configurations: workflowConfigSchema.nullable().optional(),
  current_definition_id: z.number().nullable().optional(),
  total_runs: z.number().nullable().optional(),
  workflow_uuid: z.string().nullable().optional(),
});

export type DograhWorkflowDetail = z.infer<typeof workflowDetailSchema>;

export function getWorkflow(id: number): Promise<DograhResult<DograhWorkflowDetail>> {
  return request(`/api/v1/workflow/fetch/${id}`, (body) => workflowDetailSchema.parse(body));
}

// ── the org's voice stack ───────────────────────────────────────────
// Which STT, TTS and LLM the agents actually run on. Read from the engine
// rather than from this repo's `.env`, because that is the value in force: a
// deployment that changed the voice in Dograh's UI and not here would
// otherwise be described by the screen, wrongly.

const pipelineSchema = z
  .object({
    provider: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    voice: z.string().nullable().optional(),
    language: z.string().nullable().optional(),
    base_url: z.string().nullable().optional(),
    speed: z.number().nullable().optional(),
  })
  .passthrough();

const voiceStackSchema = z.object({
  effective_configuration: z
    .object({
      stt: pipelineSchema.nullable().optional(),
      tts: pipelineSchema.nullable().optional(),
      llm: pipelineSchema.nullable().optional(),
      is_realtime: z.boolean().nullable().optional(),
    })
    .passthrough(),
  source: z.string().nullable().optional(),
});

export interface DograhVoiceStack {
  stt: z.infer<typeof pipelineSchema> | null;
  tts: z.infer<typeof pipelineSchema> | null;
  llm: z.infer<typeof pipelineSchema> | null;
  /** Where the configuration came from — `organization_v2`, a workflow, a default. */
  source: string | null;
  is_realtime: boolean;
}

export function getVoiceStack(): Promise<DograhResult<DograhVoiceStack>> {
  return request("/api/v1/organizations/model-configurations/v2", (body) => {
    const parsed = voiceStackSchema.parse(body);
    return {
      stt: parsed.effective_configuration.stt ?? null,
      tts: parsed.effective_configuration.tts ?? null,
      llm: parsed.effective_configuration.llm ?? null,
      source: parsed.source ?? null,
      is_realtime: parsed.effective_configuration.is_realtime ?? false,
    };
  });
}

/**
 * One address is enough to prove the engine is up, and it is the one the run
 * list needs anyway. `/api/health` reports it as a state rather than a boolean
 * so a trace can name what failed.
 */
const healthSchema = z.object({
  status: z.string(),
  version: z.string().nullable().optional(),
  deployment_mode: z.string().nullable().optional(),
});

export interface DograhHealth {
  status: string;
  version: string | null;
  deployment_mode: string | null;
}

export function getHealth(): Promise<DograhResult<DograhHealth>> {
  return request("/api/v1/health", (body) => {
    const parsed = healthSchema.parse(body);
    return {
      status: parsed.status,
      version: parsed.version ?? null,
      deployment_mode: parsed.deployment_mode ?? null,
    };
  });
}

// ── runs ────────────────────────────────────────────────────────────

const runSchema = z
  .object({
    id: z.number(),
    workflow_id: z.number(),
    name: z.string().nullable().optional(),
    mode: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
    is_completed: z.boolean().nullable().optional(),
    cost_info: z
      .object({ call_duration_seconds: z.number().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    gathered_context: z
      .object({
        call_id: z.string().nullable().optional(),
        call_status: z.string().nullable().optional(),
        call_disposition: z.string().nullable().optional(),
        nodes_visited: z.array(z.string()).nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    initial_context: z
      .object({
        zeus_context: z.record(z.string(), z.string()).nullable().optional(),
        runtime_configuration: z
          .object({
            stt_provider: z.string().nullable().optional(),
            tts_provider: z.string().nullable().optional(),
            tts_model: z.string().nullable().optional(),
            llm_model: z.string().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const runListSchema = z.object({
  runs: z.array(runSchema),
  total_count: z.number().nullable().optional(),
  page: z.number().nullable().optional(),
});

/** One call the agent handled, reduced to what a console row shows. */
export interface DograhRun {
  id: number;
  workflow_id: number;
  name: string | null;
  mode: string | null;
  created_at: string | null;
  is_completed: boolean;
  duration_seconds: number | null;
  /** The workflow's own verdict — `completed`, `user_idle_max_duration_exceeded`, … */
  outcome: string | null;
  /** The nodes the call actually reached, in order. Empty means it ended early. */
  nodes_visited: string[];
  /** The portal's call id, as the dialplan stamped it and Dograh kept it. */
  call_id: string | null;
  stt_provider: string | null;
  tts_provider: string | null;
  tts_model: string | null;
  llm_model: string | null;
}

function toRun(row: z.infer<typeof runSchema>): DograhRun {
  const gathered = row.gathered_context ?? {};
  const runtime = row.initial_context?.runtime_configuration ?? {};
  const zeus = row.initial_context?.zeus_context ?? {};
  return {
    id: row.id,
    workflow_id: row.workflow_id,
    name: row.name ?? null,
    mode: row.mode ?? null,
    created_at: row.created_at ?? null,
    is_completed: row.is_completed ?? false,
    duration_seconds: row.cost_info?.call_duration_seconds ?? null,
    outcome: gathered.call_disposition ?? gathered.call_status ?? null,
    nodes_visited: (gathered.nodes_visited ?? []).filter((node): node is string => typeof node === "string"),
    call_id: gathered.call_id ?? zeus.AI_CALL_ID ?? null,
    stt_provider: runtime.stt_provider ?? null,
    tts_provider: runtime.tts_provider ?? null,
    tts_model: runtime.tts_model ?? null,
    llm_model: runtime.llm_model ?? null,
  };
}

export interface RunQuery {
  page?: number;
  limit?: number;
}

/**
 * A workflow's calls, newest first.
 *
 * The id is returned as a `DograhRun` rather than the engine's row because
 * every caller wants the four derived fields (outcome, duration, nodes, the
 * portal's call id) and none wants the raw record; deriving them in one place
 * is what keeps two screens from disagreeing about what "completed" means.
 */
export async function listRuns(
  workflowId: number,
  query: RunQuery = {},
): Promise<DograhResult<DograhRun[]>> {
  const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
  const page = Math.max(query.page ?? 1, 1);
  const result = await request(
    `/api/v1/workflow/${workflowId}/runs?page=${page}&limit=${limit}`,
    (body) => runListSchema.parse(body),
  );
  if (result.state !== "ok") return result;
  return { state: "ok", data: result.data.runs.map(toRun) };
}

export function getRun(workflowId: number, runId: number): Promise<DograhResult<DograhRun>> {
  return request(`/api/v1/workflow/${workflowId}/runs/${runId}`, (body) =>
    toRun(runSchema.parse(body)),
  );
}

// The wording for a run's outcome lives in `lib/voice-labels.ts`: it is pure
// strings, and a client component has to render it without pulling this
// module — and the API key it reads — into the browser bundle.
