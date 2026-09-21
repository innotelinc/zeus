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
      return null;
    }
    const parsed = z.object({ access_token: z.string() }).safeParse(await resp.json());
    if (!parsed.success) {
      cachedToken = null;
      return null;
    }
    cachedToken = {
      value: parsed.data.access_token,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    };
    return cachedToken.value;
  } catch {
    cachedToken = null;
    return null;
  }
}

/** Drop the cached token — used after a 401 so the next call re-authenticates. */
export function avaResetToken(): void {
  cachedToken = null;
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
    return failure("unauthorized", "could not authenticate to the AVA admin API");
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
    return failure("unauthorized", "AVA admin API rejected the credentials");
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
    record_id: z.string().nullable().optional(),
    id: z.string().nullable().optional(),
    call_id: z.string().nullable().optional(),
    caller_number: z.string().nullable().optional(),
    from_number: z.string().nullable().optional(),
    agent_slug: z.string().nullable().optional(),
    agent: z.string().nullable().optional(),
    started_at: z.string().nullable().optional(),
    duration_seconds: z.number().nullable().optional(),
    outcome: z.string().nullable().optional(),
    summary: z.string().nullable().optional(),
  })
  .passthrough();
export type AvaCall = z.infer<typeof callSchema>;

const callListSchema = z
  .object({
    calls: z.array(callSchema).optional(),
    items: z.array(callSchema).optional(),
    total: z.number().nullable().optional(),
  })
  .passthrough();

const liveSchema = z
  .object({
    sessions: z.array(z.record(z.string(), z.unknown())).optional(),
    active_calls: z.array(z.record(z.string(), z.unknown())).optional(),
    count: z.number().nullable().optional(),
  })
  .passthrough();

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

export function liveStatus(): Promise<AvaResult<z.infer<typeof liveSchema>>> {
  return request("/api/system/live-status", { method: "GET", schema: liveSchema });
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
