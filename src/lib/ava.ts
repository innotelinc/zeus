/**
 * Zeus → AVA (Asterisk AI Voice Agent) admin API client.
 *
 * AVA answers every inbound call: it is the first response, and it owns the
 * agents, the live call list and the transcripts. The Zeus dashboard is the
 * operator console for it, so this module is the only place that talks to
 * AVA's admin API — browser code goes through /api/voice/*, never here.
 *
 * Env:
 *   AVA_ADMIN_URL       — admin API base (default http://127.0.0.1:8770; the
 *                         compose service publishes loopback-only, and the
 *                         portal reaches it through host.docker.internal).
 *   AVA_ADMIN_USER      — admin username (default "admin").
 *   AVA_ADMIN_PASSWORD  — admin password. Empty → standalone mode: the voice
 *                         screens report "not configured" instead of failing.
 *   AVA_ADMIN_TOKEN     — optional pre-minted JWT; skips the login round trip.
 *
 * Failure policy mirrors lib/magnate.ts: an unreachable or misconfigured
 * engine is surfaced as a typed state, never thrown and never silently
 * rendered as "no calls" — an operator must be able to tell "quiet" from
 * "broken".
 */
import { z } from "zod";

const AVA_BASE = (process.env.AVA_ADMIN_URL ?? "http://127.0.0.1:8770")
  .trim()
  .replace(/\/+$/, "");

const AVA_USER = (process.env.AVA_ADMIN_USER ?? "admin").trim();
const AVA_PASSWORD = process.env.AVA_ADMIN_PASSWORD ?? "";
const AVA_STATIC_TOKEN = (process.env.AVA_ADMIN_TOKEN ?? "").trim();

export function avaConfigured(): boolean {
  return Boolean(AVA_STATIC_TOKEN || AVA_PASSWORD);
}

/**
 * What to log at startup when the voice engine is not configured, or null when
 * there is nothing to say.
 *
 * `avaConfigured()` decides every Voice screen, and it is read from *this
 * process's* environment. Compose reads `env_file` when it **creates** a
 * container, so a portal created before `AVA_ADMIN_PASSWORD` was added to
 * `.env` has the value on disk and not in the process — a state whose only
 * symptom is an empty Voice screen, whose most obvious repair is a `docker
 * compose restart` that cannot work, and which therefore costs a round trip
 * worth avoiding. `/dashboard/health` reports the same fact as a state, but
 * only once somebody thinks to look there; the boot log needs nobody (see
 * docs/ava-runbook.md §7, and §10 for what a caller hears when the engine is
 * down).
 *
 * Deliberately does not guess at the address: this portal is host-networked in
 * the full stack and bridged in the dev profile, so "is AVA_ADMIN_URL right"
 * has two different answers and the credential is the question either way.
 */
export function avaConfigurationWarning(): string | null {
  if (avaConfigured()) return null;
  return (
    "the voice engine is not configured in this process: neither " +
    "AVA_ADMIN_PASSWORD nor AVA_ADMIN_TOKEN is set, so the Voice screens will " +
    "report it as not configured. Set the password in .env and recreate the " +
    "portal — env_file is read at container CREATE time, so a restart reuses " +
    "the environment the container already has (docs/ava-runbook.md §7)."
  );
}

/**
 * Where the portal talks to the admin API. Exported so the health probe in
 * /api/health describes the same address the screens use, rather than a
 * second reading of the same variable that can drift from it.
 */
export function avaAdminBase(): string {
  return AVA_BASE;
}

export type AvaState = "ok" | "unreachable" | "unauthorized" | "invalid" | "not_configured";

export type AvaResult<T> =
  | { state: "ok"; data: T }
  | { state: Exclude<AvaState, "ok">; error: string; data: null };

function failure<T>(state: Exclude<AvaState, "ok">, error: string): AvaResult<T> {
  return { state, error, data: null };
}

// ── token handling ────────────────────────────────────────────────
// AVA issues a JWT valid for 24h (admin_ui/backend/auth.py). Cache it in
// module scope so a dashboard refresh does not re-login per request, and
// renew a minute early so a token cannot expire mid-flight.
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;
let cachedToken: { value: string; expiresAt: number } | null = null;

// Why the last attempt produced no usable token. Kept at module scope so
// request() can report the specific cause: AVA leaves the admin account on a
// one-time password at first run and refuses every other API call until it is
// changed, and from the outside that is indistinguishable from wrong
// credentials — "rejected the credentials" sends an operator to the wrong
// place. See admin_ui/backend/auth.py, ensure_default_user().
let authFailure: string | null = null;

const FIRST_RUN_HINT =
  "AVA's admin password is still its first-run value, and AVA refuses API " +
  "calls until it is changed — set AVA_ADMIN_PASSWORD from the password in " +
  "data/ava/project/config/.first-run-password on the host that runs the " +
  "admin container (docs/ava-integration.md)";

async function getToken(): Promise<string | null> {
  if (AVA_STATIC_TOKEN) return AVA_STATIC_TOKEN;
  if (!AVA_PASSWORD) return null;
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;

  const body = new URLSearchParams({
    username: AVA_USER,
    password: AVA_PASSWORD,
    grant_type: "password",
  });

  try {
    const resp = await fetch(`${AVA_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      cachedToken = null;
      authFailure = `AVA admin API returned ${resp.status} for ${AVA_USER}/AVA_ADMIN_PASSWORD`;
      return null;
    }
    const parsed = z
      .object({
        access_token: z.string(),
        // Login succeeds while this is set; every other endpoint then answers
        // 403 (auth.py gates all data routers on it).
        must_change_password: z.boolean().optional(),
      })
      .safeParse(await resp.json());
    if (!parsed.success) {
      cachedToken = null;
      authFailure = "AVA admin API returned an unexpected login payload";
      return null;
    }
    if (parsed.data.must_change_password) {
      // Do not cache it: a token that cannot read a single endpoint would
      // turn this into a 403 per screen with nothing naming the cause.
      cachedToken = null;
      authFailure = FIRST_RUN_HINT;
      return null;
    }
    authFailure = null;
    cachedToken = {
      value: parsed.data.access_token,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    };
    return cachedToken.value;
  } catch {
    cachedToken = null;
    authFailure = null;
    return null;
  }
}

/** Drop the cached token — used after a 401 so the next call re-authenticates. */
export function avaResetToken(): void {
  cachedToken = null;
  authFailure = null;
}

// ── request plumbing ──────────────────────────────────────────────
async function request<T>(
  path: string,
  init: RequestInit & { schema: z.ZodType<T> },
): Promise<AvaResult<T>> {
  if (!avaConfigured()) {
    return failure("not_configured", "AVA admin API is not configured");
  }

  const token = await getToken();
  if (!token) {
    return failure("unauthorized", authFailure ?? "could not authenticate to the AVA admin API");
  }

  let resp: Response;
  try {
    resp = await fetch(`${AVA_BASE}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    return failure(
      "unreachable",
      e instanceof Error ? e.message : "AVA admin API unreachable",
    );
  }

  if (resp.status === 401 || resp.status === 403) {
    avaResetToken();
    // 401 is the credential; 403 is AVA's must_change_password gate (or an
    // account without access), and a token minted before the change looks
    // exactly like this. Name the difference rather than collapsing both.
    return failure(
      "unauthorized",
      resp.status === 403
        ? "AVA admin API refused the request (403) — " + FIRST_RUN_HINT
        : `AVA admin API rejected the credentials for ${AVA_USER}`,
    );
  }
  if (!resp.ok) {
    return failure("invalid", `AVA admin API returned ${resp.status}`);
  }

  let payload: unknown;
  try {
    payload = await resp.json();
  } catch {
    return failure("invalid", "AVA admin API returned a non-JSON body");
  }

  const parsed = init.schema.safeParse(payload);
  if (!parsed.success) {
    return failure("invalid", "AVA admin API returned an unexpected shape");
  }
  return { state: "ok", data: parsed.data };
}

// ── schemas ───────────────────────────────────────────────────────
// Deliberately permissive: AVA evolves (v7.6 today) and a strict schema here
// would turn a cosmetic field addition into a broken dashboard. Only the
// fields the UI depends on are required.
export const agentSchema = z
  .object({
    slug: z.string(),
    display_name: z.string().nullable().optional(),
    role_label: z.string().nullable().optional(),
    extension: z.string().nullable().optional(),
    provider: z.string().nullable().optional(),
    voice: z.string().nullable().optional(),
    greeting: z.string().nullable().optional(),
    prompt: z.string().nullable().optional(),
    tools_json: z.string().nullable().optional(),
    is_active: z.union([z.boolean(), z.number()]).optional(),
    is_default: z.union([z.boolean(), z.number()]).optional(),
    updated_at: z.string().nullable().optional(),
  })
  .passthrough();
export type AvaAgent = z.infer<typeof agentSchema>;

const callSchema = z
  .object({
    // AVA names the key `id` on a record and `record_id` on some payloads.
    record_id: z.string().nullable().optional(),
    id: z.string().nullable().optional(),
    call_id: z.string().nullable().optional(),
    caller_number: z.string().nullable().optional(),
    caller_name: z.string().nullable().optional(),
    from_number: z.string().nullable().optional(),
    called_number: z.string().nullable().optional(),
    agent_slug: z.string().nullable().optional(),
    agent_name: z.string().nullable().optional(),
    agent: z.string().nullable().optional(),
    started_at: z.string().nullable().optional(),
    start_time: z.string().nullable().optional(),
    end_time: z.string().nullable().optional(),
    duration_seconds: z.number().nullable().optional(),
    outcome: z.string().nullable().optional(),
    summary: z.string().nullable().optional(),
    // Latency the engine measured for the call — the honest source for
    // "how fast does this feel", rather than a wall-clock guess.
    avg_turn_latency_ms: z.number().nullable().optional(),
    max_turn_latency_ms: z.number().nullable().optional(),
    total_turns: z.number().nullable().optional(),
    barge_in_count: z.number().nullable().optional(),
    routing_method: z.string().nullable().optional(),
  })
  .passthrough();
export type AvaCall = z.infer<typeof callSchema>;

/** The record id, whichever key THIS payload used. */
export function callRecordId(call: AvaCall): string | null {
  return call.record_id ?? call.id ?? null;
}

/** The call's start time, whichever key this payload used. */
export function callStartTime(call: AvaCall): string | null {
  return call.start_time ?? call.started_at ?? null;
}

/**
 * The full record. The list endpoint deliberately omits the heavy fields
 * (transcript turns, tool payloads), and `transfer_destination` only appears
 * here — so a hand-off cannot be confirmed from the list alone.
 */
const callRecordSchema = callSchema.extend({
  transfer_destination: z.string().nullable().optional(),
  pipeline_name: z.string().nullable().optional(),
  provider_name: z.string().nullable().optional(),
  context_name: z.string().nullable().optional(),
  tool_calls: z.array(z.record(z.string(), z.unknown())).optional(),
  error_message: z.string().nullable().optional(),
});
export type AvaCallRecord = z.infer<typeof callRecordSchema>;

export const transcriptTurnSchema = z
  .object({
    role: z.string().optional(),
    content: z.string().nullable().optional(),
    text: z.string().nullable().optional(),
    timestamp: z.string().nullable().optional(),
  })
  .passthrough();
export type AvaTranscriptTurn = z.infer<typeof transcriptTurnSchema>;

const callListSchema = z
  .object({
    calls: z.array(callSchema).optional(),
    items: z.array(callSchema).optional(),
    total: z.number().nullable().optional(),
  })
  .passthrough();

type AvaLiveSession = Record<string, unknown>;
type AvaLiveStatus = {
  sessions: AvaLiveSession[];
  count: number;
  sessionsState: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * AVA's older response exposed `sessions` / `active_calls` directly. The
 * current live-status hub wraps them in a component snapshot, with session
 * data under `components.sessions.details`. Normalize both wire formats here
 * so callers never need to know which AVA release produced the response.
 */
export function normalizeLiveStatus(payload: unknown): AvaLiveStatus | null {
  if (!isRecord(payload)) return null;

  const components = isRecord(payload.components) ? payload.components : {};
  const rootSessions = payload.sessions;
  const hasKnownShape =
    isRecord(payload.components) ||
    Array.isArray(rootSessions) ||
    Array.isArray(payload.active_calls) ||
    (isRecord(rootSessions) && isRecord(rootSessions.details));
  if (!hasKnownShape) return null;
  const rootComponent = isRecord(rootSessions) ? rootSessions : null;
  const sessionsComponentValue = components.sessions ?? rootComponent;
  const sessionsComponent = isRecord(sessionsComponentValue) ? sessionsComponentValue : null;
  const details = sessionsComponent && isRecord(sessionsComponent.details)
    ? sessionsComponent.details
    : {};

  const sessions = Array.isArray(rootSessions)
    ? rootSessions
    : Array.isArray(payload.active_calls)
      ? payload.active_calls
      : Array.isArray(details.sessions)
        ? details.sessions
        : [];
  const activeCount = details.active_calls;
  const count = typeof payload.count === "number"
    ? payload.count
    : typeof activeCount === "number"
      ? activeCount
      : sessions.length;
  const sessionsState = typeof sessionsComponent?.state === "string"
    ? sessionsComponent.state
    : null;

  return {
    sessions: sessions.filter(isRecord),
    count,
    sessionsState,
  };
}

const liveSchema = z
  .unknown()
  .transform((payload, ctx) => {
    const normalized = normalizeLiveStatus(payload);
    if (!normalized) {
      ctx.addIssue({ code: "custom", message: "expected an AVA live-status object" });
      return z.NEVER;
    }
    return normalized;
  });

// ── public surface ────────────────────────────────────────────────
export function listAgents(): Promise<AvaResult<AvaAgent[]>> {
  return request("/api/agents", { method: "GET", schema: z.array(agentSchema) });
}

export function getAgent(slug: string): Promise<AvaResult<AvaAgent>> {
  return request(`/api/agents/${encodeURIComponent(slug)}`, {
    method: "GET",
    schema: agentSchema,
  });
}

export function listCalls(limit = 50): Promise<AvaResult<{ calls: AvaCall[]; total: number | null }>> {
  return request(`/api/calls?limit=${encodeURIComponent(String(limit))}`, {
    method: "GET",
    schema: callListSchema,
  }).then((res) =>
    res.state === "ok"
      ? {
          state: "ok" as const,
          data: {
            calls: res.data.calls ?? res.data.items ?? [],
            total: res.data.total ?? null,
          },
        }
      : res,
  );
}

export function liveStatus(): Promise<AvaResult<AvaLiveStatus>> {
  return request("/api/system/live-status", { method: "GET", schema: liveSchema });
}

/** One call's full record (adds transfer destination + tool calls). */
export function getCall(recordId: string): Promise<AvaResult<AvaCallRecord>> {
  return request(`/api/calls/${encodeURIComponent(recordId)}`, {
    method: "GET",
    schema: callRecordSchema,
  });
}

/**
 * What was said. This is the record the operator needs when a caller disputes
 * how a hand-off went, so it is read from AVA rather than reconstructed.
 */
export function getCallTranscript(
  recordId: string,
): Promise<AvaResult<{ call_id: string | null; turns: AvaTranscriptTurn[] }>> {
  return request(`/api/calls/${encodeURIComponent(recordId)}/transcript`, {
    method: "GET",
    schema: z
      .object({
        call_id: z.string().nullable().optional(),
        conversation_history: z.array(transcriptTurnSchema).optional(),
      })
      .passthrough(),
  }).then((res) =>
    res.state === "ok"
      ? {
          state: "ok" as const,
          data: {
            call_id: res.data.call_id ?? null,
            turns: res.data.conversation_history ?? [],
          },
        }
      : res,
  );
}

/**
 * FreePBX dialplan AVA generates for an agent — the handoff/transfer targets
 * the operator can paste, and the reference for what this account's agent is
 * allowed to dial.
 */
export function agentDialplan(slug: string): Promise<AvaResult<{ dialplan: string }>> {
  return request(`/api/agents/${encodeURIComponent(slug)}/dialplan`, {
    method: "GET",
    schema: z.object({ dialplan: z.string().catch("") }).passthrough(),
  });
}

export const createAgentSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]{1,64}$/, "agent slug must be [a-z0-9], max 64"),
  display_name: z.string().min(1),
  prompt: z.string().min(1),
  greeting: z.string().optional(),
  role_label: z.string().optional(),
  extension: z.string().optional(),
  provider: z.string().optional(),
  voice: z.string().optional(),
  tools: z.array(z.string()).optional(),
});

export type CreateAgentInput = z.infer<typeof createAgentSchema>;

export function createAgent(input: CreateAgentInput): Promise<AvaResult<AvaAgent>> {
  return request("/api/agents", {
    method: "POST",
    body: JSON.stringify({ ...input, tools_json: input.tools ? JSON.stringify(input.tools) : undefined }),
    schema: agentSchema,
  });
}
