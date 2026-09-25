"use client";

import { useCallback, useEffect, useState } from "react";
import { api, fmtDate } from "@/lib/client-api";
import { SparklesIcon, PhoneIcon, RefreshIcon, CheckCircleIcon } from "@/components/icons";
import { useToast } from "@/components/ToastProvider";
// `import type` is erased entirely at compile time, so these shapes reach the
// browser without pulling `lib/dograh.ts` — and the API key it reads — into the
// client bundle. The one *value* this component needs from the engine's
// vocabulary lives in its own module for the same reason.
import type { DograhTurnConfig, DograhVoiceStack, DograhWorkflow } from "@/lib/dograh";
import { describeOutcome } from "@/lib/voice-labels";
import type { InterviewLine } from "@/lib/voice-bindings";

/** One agent, as this screen needs it: the workflow plus how it takes turns. */
export interface AgentRow extends DograhWorkflow {
  turn: DograhTurnConfig | null;
}

/**
 * One of the agent's calls, as `/api/voice/calls` serves it.
 *
 * Deliberately a mirror of the screen's needs rather than an import of the
 * server module: this is a client component, and the server module reaches the
 * engine and the database.
 */
export interface RunRow {
  id: number;
  workflow_id: number;
  name: string | null;
  created_at: string | null;
  duration_seconds: number | null;
  outcome: string | null;
  nodes_visited: string[];
  call_id: string | null;
}

interface RecordedCall {
  call_id: string;
  did: string | null;
  capstone_binding: string | null;
  started_at: string;
  disposition: string;
  handoffs: Array<{ to: string; at: string }>;
}

interface Props {
  agents: AgentRow[];
  /** `ok`, or why the agents could not be read. */
  agentsState: string;
  agentsError: string | null;
  /** What the agents actually run on, read from the engine. */
  voice: DograhVoiceStack | null;
  voiceError?: string | null;
  /** This account's numbers and the workflow each reaches. */
  lines: InterviewLine[];
  /** Recent calls, for the workflows these lines reach. */
  runs: RunRow[];
  /** The Capstone add-on's state for this account, as the routing path sees it. */
  capstone: { state: string; reason: string };
}

const POLL_MS = 15_000;

/**
 * How the agent takes turns, in the operator's words.
 *
 * These four values are the whole of the interruption behaviour — whether the
 * agent yields when the caller starts talking, and how long it waits before
 * deciding they have finished. Every workflow shipped with an *empty* config,
 * which fell back to a plain speech timeout: the agent heard a pause, assumed
 * the turn was over, and talked over the caller. That is why they are on the
 * screen and not buried in Dograh.
 */
function turnSummary(turn: DograhTurnConfig | null): string {
  if (!turn || !turn.turn_stop_strategy) {
    return "Default turn detection — the agent waits out a silence, so it can talk over a pause";
  }
  const parts: string[] = [];
  if (turn.turn_stop_strategy === "turn_analyzer") {
    parts.push(
      `Listens for the end of a thought${
        turn.smart_turn_stop_secs ? ` (${turn.smart_turn_stop_secs}s)` : ""
      }`,
    );
  } else {
    parts.push(`Turn stop: ${turn.turn_stop_strategy.replace(/_/g, " ")}`);
  }
  if (turn.max_call_duration) {
    parts.push(`calls capped at ${Math.round(turn.max_call_duration / 60)} min`);
  }
  return parts.join(" · ");
}

/** One line naming the voice that will speak, for a screen with no room. */
function voiceLine(voice: DograhVoiceStack | null): string {
  if (!voice) return "The engine did not report its voice configuration";
  const part = (label: string, config: DograhVoiceStack["stt"]) =>
    config
      ? `${label} ${config.model ?? config.provider ?? "unknown"}${config.voice ? `/${config.voice}` : ""}`
      : `${label} not configured`;
  return [part("Hears with", voice.stt), part("speaks with", voice.tts)].join(", ");
}

/** The path a call took, in the operator's words. */
function pathLabel(record: RecordedCall): string {
  if (record.handoffs.length === 0) return "no hand-off";
  return ["agent", ...record.handoffs.map((hop) => hop.to)].join(" → ");
}

export default function VoiceSection({
  agents,
  agentsState,
  agentsError,
  voice,
  voiceError,
  lines: initialLines,
  runs,
  capstone,
}: Props) {
  const { toast } = useToast();
  const [lines, setLines] = useState(initialLines);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [recorded, setRecorded] = useState<RecordedCall[]>([]);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [engine, setEngine] = useState<string>("ok");
  const [busy, setBusy] = useState(false);

  const poll = useCallback(async () => {
    try {
      const data = (await api("/api/voice/live")) as {
        recorded?: RecordedCall[];
        error?: string | null;
        engine?: string;
      };
      // The portal's own record is kept even on the engine's error path: it is
      // written by the switch, so a borked engine is precisely when an operator
      // wants to see which calls are still up.
      setRecorded(data.recorded ?? []);
      setEngine(data.engine ?? "ok");
      setLiveError(data.error ?? null);
    } catch (e) {
      setLiveError(e instanceof Error ? e.message : "Live status unavailable");
      setEngine("unreachable");
    }
  }, []);

  useEffect(() => {
    // Deferred rather than called directly: an immediate setState inside an
    // effect triggers a cascading render (react-hooks/set-state-in-effect).
    const first = setTimeout(poll, 0);
    const timer = setInterval(poll, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [poll]);

  /**
   * One number's agent. The add-on gate, the number's ownership, the target's
   * charset and whether Dograh actually carries that workflow are all enforced
   * server-side — this only reports what the API said, so the UI cannot accept
   * a value the PBX would refuse.
   */
  async function saveBinding(did: string, value: string) {
    setBusy(true);
    try {
      const data = (await api("/api/voice/agent-mapping", {
        method: "PUT",
        body: JSON.stringify({ did, capstone_binding: value }),
      })) as { lines?: InterviewLine[] };
      if (data.lines) setLines(data.lines);
      setDrafts((prev) => ({ ...prev, [did]: "" }));
      toast.success(
        value
          ? `${did} now reaches “${value}”.`
          : `${did} will refuse to an operator when the agent transfers.`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change the agent");
    } finally {
      setBusy(false);
    }
  }

  const broken = agentsState !== "ok" || engine !== "ok";

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-white">
            <SparklesIcon size={20} className="text-brand-300" />
            Voice Agents
          </h1>
          <p className="mt-1 text-sm text-white/50">
            Dograh answers your calls and runs the conversations. Which agent answers is chosen per
            number, below.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void poll()}
          className="inline-flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-white/60 transition hover:bg-white/[0.06] hover:text-white"
        >
          <RefreshIcon size={16} /> Refresh
        </button>
      </header>

      {broken && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          {agentsError ?? liveError ?? "The voice engine could not be read."} Calls may not be
          answered until it is healthy.
        </div>
      )}

      {/* ── What the agent runs on ─────────────────────────────── */}
      <section className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white/40">
          The voice on the line
        </h2>
        <p className="mt-2 text-sm text-white/70">{voiceLine(voice)}</p>
        <p className="mt-1 text-xs text-white/30">
          {voiceError
            ? voiceError
            : "Read from the engine, not from this deployment's config — this is the value in force."}
        </p>
      </section>

      {/* ── Which agent answers which number ───────────────────── */}
      <section className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white/40">
          Which agent answers
        </h2>
        <p className="mt-2 text-sm text-white/50">
          A workflow is a property of the <em>number</em>: one account can hold a support line and
          an interview line, and they do not have to reach the same agent. This is the same value
          the PBX reads when the call comes in, so what you set here is what the dialplan does.
        </p>

        {capstone.state !== "enabled" ? (
          <p className="mt-3 text-sm text-amber-300">
            {capstone.state === "unknown"
              ? `Could not verify the interviews add-on (${capstone.reason}). Nothing is shown as off.`
              : "The interviews add-on is not enabled for this account."}
          </p>
        ) : lines.length === 0 ? (
          <p className="mt-3 text-sm text-white/40">No active numbers on this account yet.</p>
        ) : (
          <ul className="mt-4 space-y-2">
            {lines.map((line) => {
              const draft = drafts[line.did] ?? line.capstone_binding ?? "";
              const changed = draft.trim() !== (line.capstone_binding ?? "");
              return (
                <li
                  key={line.did}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.06] px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-white">{line.did}</p>
                    <p className="truncate text-xs text-white/40">
                      {line.capstone_binding
                        ? `transfers reach “${line.capstone_binding}”`
                        : "no agent bound — transfers refuse to an operator"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {/* A select, not a text field: the value has to be a workflow
                        that exists, and a free-text box invites the operator to
                        discover that at call time instead of here. */}
                    <select
                      aria-label={`Agent for ${line.did}`}
                      className="w-56 rounded-lg border px-3 py-1.5 text-sm outline-none transition focus:border-brand-500/50"
                      style={{
                        background: "var(--input-bg)",
                        borderColor: "var(--input-border)",
                        color: "var(--foreground)",
                      }}
                      value={draft}
                      onChange={(e) =>
                        setDrafts((prev) => ({ ...prev, [line.did]: e.target.value }))
                      }
                    >
                      <option value="">No agent — refuse to an operator</option>
                      {agents
                        .filter((agent) => agent.status === "active")
                        .map((agent) => (
                          <option key={agent.id} value={String(agent.id)}>
                            {agent.name}
                          </option>
                        ))}
                    </select>
                    <button
                      type="button"
                      disabled={busy || !changed}
                      onClick={() => void saveBinding(line.did, draft.trim())}
                      className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-xs text-white/70 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-40"
                    >
                      Save
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── Live now ───────────────────────────────────────────── */}
      <section className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-white/40">
          <PhoneIcon size={16} /> Live now
        </h2>
        {liveError ? (
          <p className="mt-3 text-sm text-amber-300">The engine is not answering: {liveError}</p>
        ) : null}
        {recorded.length === 0 ? (
          <p className="mt-3 text-sm text-white/40">No calls in progress.</p>
        ) : (
          <ul className="mt-3 divide-y divide-white/[0.05]">
            {recorded.map((record) => (
              <li key={record.call_id} className="py-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-white/70">
                    {record.did ?? "unknown number"}
                    {record.capstone_binding ? (
                      <span className="text-white/40"> · {record.capstone_binding}</span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-white/40">
                    {record.disposition.replace(/_/g, " ")} · {pathLabel(record)}
                  </span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-white/30">
                  {/* The id both products carry — the thing to quote in a log search. */}
                  <span className="font-mono">{record.call_id}</span>
                  <span>started {fmtDate(record.started_at)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Agents ─────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white/40">Agents</h2>
        <p className="mt-2 text-sm text-white/50">
          These are your interviewer and reception agents, exactly as the engine has them. Editing
          one — its prompts, its nodes, its branching — happens in Dograh; the System Map links
          straight to it.
        </p>

        <ul className="mt-4 space-y-2">
          {agents.length === 0 && (
            <li className="text-sm text-white/40">
              No agents on the voice engine yet. Create one in Dograh and it appears here.
            </li>
          )}
          {agents.map((agent) => (
            <li
              key={agent.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.06] px-4 py-3"
            >
              <div className="min-w-0">
                <p className="flex items-center gap-2 truncate text-sm font-medium text-white">
                  {agent.name}
                  {agent.status !== "active" ? (
                    <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 text-[10px] text-white/35">
                      {agent.status}
                    </span>
                  ) : null}
                  {lines.some(
                    (line) =>
                      line.capstone_binding === String(agent.id) ||
                      line.capstone_binding === agent.name,
                  ) ? (
                    <span className="inline-flex items-center gap-1 text-xs text-mint-400">
                      <CheckCircleIcon size={13} /> Answering a line
                    </span>
                  ) : null}
                </p>
                <p className="truncate text-xs text-white/40">{turnSummary(agent.turn)}</p>
              </div>
              <span className="shrink-0 text-xs text-white/30">
                {agent.total_runs ?? 0} call{agent.total_runs === 1 ? "" : "s"}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* ── Recent calls ───────────────────────────────────────── */}
      <section className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white/40">
          Recent calls
        </h2>
        {runs.length === 0 ? (
          <p className="mt-3 text-sm text-white/40">
            No calls yet — none of these agents has handled one.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-white/[0.05]">
            {runs.map((run) => (
              <li key={`${run.workflow_id}-${run.id}`} className="py-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-white/70">
                    {run.nodes_visited[0] ?? run.name ?? "call"}
                  </span>
                  <span className="shrink-0 text-white/40">
                    {run.created_at ? fmtDate(run.created_at) : ""}
                    {run.duration_seconds ? ` · ${run.duration_seconds}s` : ""}
                  </span>
                </div>
                <p className="mt-1 text-xs text-white/50">{describeOutcome(run.outcome)}</p>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-white/30">
                  {run.call_id ? (
                    /* The id both products carry — what to search the engine, the
                       PBX log and the control panel by. */
                    <span className="font-mono">{run.call_id}</span>
                  ) : null}
                  {run.nodes_visited.length > 0 ? (
                    <span>{run.nodes_visited.length} step(s) reached</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
