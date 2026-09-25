import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-helpers";
import { addonStatus } from "@/lib/addons";
import { SPAN_KIND, withSpan, type Span } from "@/lib/otel";
import { listVoiceCalls, type VoiceCall } from "@/lib/voice-calls";
import { dograhConfigured, listRuns, listWorkflows, type DograhRun } from "@/lib/dograh";

export const dynamic = "force-dynamic";

/** How many of a workflow's most recent runs to scan when joining. */
const RUNS_PER_WORKFLOW = 50;

export interface CallRow extends VoiceCall {
  /**
   * The agent's own record of this call, when one exists.
   *
   * Joined on the call id, which is the thing both sides carry: the dialplan
   * stamps it as `AI_CALL_ID`, Dograh keeps it in the run's context, and this
   * table is keyed by it. That is the whole reason the join is possible — no
   * name matching, no timestamp fuzz.
   */
  run: {
    id: number;
    workflow_id: number;
    outcome: string | null;
    duration_seconds: number | null;
    nodes_visited: string[];
  } | null;
}

/**
 * GET /api/voice/calls?limit=50
 *
 * This account's calls, with what the agent did on each.
 *
 * The list is the portal's own `voice_calls` — written by the switch from AMI
 * events — and **not** the engine's, for two reasons. It exists whether or not
 * an agent picked the call up, and it is already scoped to one account by
 * `account_id`, which is the authorization boundary: the engine's run list is
 * estate-wide, so a screen that listed it directly would show one customer
 * another customer's calls. The runs are joined in afterwards, and only for the
 * workflows this account's numbers actually reach.
 *
 * Read-only, and returned even when the add-on is off: removing the data when a
 * subscription lapses would destroy the account's own call records.
 */
export async function GET(req: Request) {
  return withSpan("voice.calls.list", (span) => listCallsFor(req, span), {
    kind: SPAN_KIND.SERVER,
    attributes: { "http.route": "/api/voice/calls", "http.method": "GET" },
  });
}

async function listCallsFor(req: Request, span: Span): Promise<Response> {
  const { user, error } = await requireUser();
  if (error) return error;

  const raw = new URL(req.url).searchParams.get("limit");
  const parsedLimit = raw ? Number.parseInt(raw, 10) : 50;
  if (raw && (!Number.isFinite(parsedLimit) || parsedLimit < 1 || parsedLimit > 500)) {
    return NextResponse.json({ error: "limit must be 1-500" }, { status: 400 });
  }

  const calls = listVoiceCalls(parsedLimit, user.id);
  const addon = await addonStatus("agents", { user: user.email });
  span.setAttribute("zeus.calls.count", calls.length);

  const withRuns = dograhConfigured()
    ? await joinRuns(calls, span)
    : calls.map((call): CallRow => ({ ...call, run: null }));

  return NextResponse.json({
    configured: dograhConfigured(),
    calls: withRuns,
    total: withRuns.length,
    addon,
  });
}

/**
 * Attach each call's run, by workflow.
 *
 * Runs are fetched **per workflow this account reaches**, not per call: a
 * hundred calls to one interview line is one request, and the alternative —
 * asking the engine about each call id — is both slower and impossible, since
 * the API has no by-call-id lookup.
 *
 * A failure here degrades to `run: null` rather than failing the request. The
 * portal's record is the answer to "what happened"; the run is the detail. A
 * screen that showed nothing because the detail was unavailable would be worse
 * than one that says what it knows.
 */
async function joinRuns(calls: VoiceCall[], span: Span): Promise<CallRow[]> {
  const bindings = [
    ...new Set(calls.map((call) => call.capstone_binding).filter((b): b is string => Boolean(b))),
  ];
  if (bindings.length === 0) return calls.map((call) => ({ ...call, run: null }));

  const workflows = await listWorkflows();
  if (workflows.state !== "ok") {
    span.setAttribute("zeus.calls.runs", "unavailable");
    return calls.map((call) => ({ ...call, run: null }));
  }

  // A binding is the workflow's *extension* as the dialplan knows it. Dograh's
  // list carries ids and names, so match on either: an operator who typed the
  // id, and one who typed the name, both get their runs joined.
  const idFor = new Map<string, number>();
  for (const workflow of workflows.data) {
    idFor.set(String(workflow.id), workflow.id);
    idFor.set(workflow.name, workflow.id);
  }

  const wanted = [...new Set(bindings.map((b) => idFor.get(b)).filter((id): id is number => id !== undefined))];
  if (wanted.length === 0) return calls.map((call) => ({ ...call, run: null }));

  const byCallId = new Map<string, DograhRun>();
  await Promise.all(
    wanted.map(async (workflowId) => {
      const runs = await listRuns(workflowId, { limit: RUNS_PER_WORKFLOW });
      if (runs.state !== "ok") return;
      for (const run of runs.data) {
        if (run.call_id) byCallId.set(run.call_id, run);
      }
    }),
  );

  span.setAttribute("zeus.calls.runs", byCallId.size);
  return calls.map((call): CallRow => {
    const run = byCallId.get(call.call_id);
    return {
      ...call,
      run: run
        ? {
            id: run.id,
            workflow_id: run.workflow_id,
            outcome: run.outcome,
            duration_seconds: run.duration_seconds,
            nodes_visited: run.nodes_visited,
          }
        : null,
    };
  });
}
