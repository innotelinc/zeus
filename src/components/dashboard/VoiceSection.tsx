"use client";

import { useCallback, useEffect, useState } from "react";
import { api, fmtDate } from "@/lib/client-api";
import {
  SparklesIcon,
  PhoneIcon,
  RefreshIcon,
  CheckCircleIcon,
  AlertCircleIcon,
  FileTextIcon,
} from "@/components/icons";
import { useToast } from "@/components/ToastProvider";
import { Badge, Dot, Button, Card, CardHeader, EmptyState, PageHeader, Stat, Tabs } from "@/components/ui";
// `import type` is erased entirely at compile time, so these shapes reach the
// browser without pulling `lib/dograh.ts` — and the API key it reads — into the
// client bundle. The one *value* this component needs from the engine's
// vocabulary lives in its own module for the same reason.
import type { DograhTurnConfig, DograhVoiceStack, DograhWorkflow } from "@/lib/dograh";
import type { ProxiedLauncher } from "@/lib/console";
import { describeOutcome, describePath } from "@/lib/voice-labels";
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
  /**
   * The products this screen hands off to — Dograh's workflow editor,
   * Workflow Studio, the Capstone dashboard, FreePBX. Resolved server-side so
   * the client never reads the environment.
   */
  launchers: ProxiedLauncher[];
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

/** One layer of the voice pipeline — what the agent hears or speaks with. */
function PipelineRow({
  label,
  config,
}: {
  label: string;
  config: DograhVoiceStack["stt"];
}) {
  const name = config
    ? `${config.model ?? config.provider ?? "unknown"}${config.voice ? ` · ${config.voice}` : ""}`
    : null;
  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/[0.04] py-2 last:border-0">
      <span className="text-xs uppercase tracking-wide text-white/35">{label}</span>
      {name ? (
        <span className="truncate font-mono text-xs text-white/70">{name}</span>
      ) : (
        <Badge tone="warning">not configured</Badge>
      )}
    </div>
  );
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
  launchers,
}: Props) {
  const { toast } = useToast();
  const [tab, setTab] = useState("overview");
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
  const activeAgents = agents.filter((agent) => agent.status === "active");
  const bound = new Set(lines.map((line) => line.capstone_binding).filter(Boolean));
  const boundCount = lines.filter((line) => line.capstone_binding).length;
  const totalRuns = agents.reduce((sum, agent) => sum + (agent.total_runs ?? 0), 0);
  const editUrl = launchers.find((launcher) => launcher.id === "workflows")?.href ?? null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Voice agents"
        icon={<SparklesIcon size={20} className="text-brand-300" />}
        description="Dograh answers your calls and runs the conversations. Which agent answers is chosen per number, so one account can hold a support line and an interview line."
        actions={
          <>
            <Button size="sm" onClick={() => void poll()}>
              <RefreshIcon size={14} /> Refresh
            </Button>
            {editUrl ? (
              <Button size="sm" variant="primary" href={editUrl} external title="Open the Dograh workflow editor">
                Edit in Dograh ↗
              </Button>
            ) : null}
          </>
        }
      />

      {broken && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          <AlertCircleIcon size={16} className="mt-0.5 shrink-0" />
          <span>
            {agentsError ?? liveError ?? "The voice engine could not be read."} Calls may not be
            answered until it is healthy.
          </span>
        </div>
      )}

      {/* ── The at-a-glance row ────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Agents"
          value={agents.length}
          hint={`${activeAgents.length} active`}
          icon={<SparklesIcon size={13} />}
        />
        <Stat
          label="Lines answering"
          value={`${boundCount}/${lines.length}`}
          hint="numbers bound to an agent"
          icon={<PhoneIcon size={13} />}
        />
        <Stat
          label="Live now"
          value={recorded.length}
          hint={engine === "ok" ? "engine connected" : `engine ${engine}`}
          icon={<Dot tone={engine === "ok" ? "success" : "danger"} />}
        />
        <Stat
          label="Calls handled"
          value={totalRuns}
          hint="across all agents"
          icon={<FileTextIcon size={13} />}
        />
      </div>

      {/* ── Facets of the one job ──────────────────────────────── */}
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "routing", label: "Routing", count: boundCount },
          { id: "agents", label: "Agents", count: agents.length },
          { id: "calls", label: "Calls", count: runs.length || null },
        ]}
      />

      {tab === "overview" && (
        <div className="grid gap-5 lg:grid-cols-2">
          {/* What the agent runs on */}
          <Card>
            <CardHeader
              title="The voice on the line"
              answers="Read from the engine, not from this deployment's config — this is the value in force."
            />
            {voice ? (
              <div>
                <PipelineRow label="Hears with" config={voice.stt} />
                <PipelineRow label="Speaks with" config={voice.tts} />
                <PipelineRow label="Thinks with" config={voice.llm} />
                {voice.source ? (
                  <p className="mt-2 text-xs text-white/35">Configuration source: {voice.source}</p>
                ) : null}
              </div>
            ) : (
              <EmptyState
                title="The engine did not report its voice configuration"
                description={voiceError ?? "Dograh answered, but its model configuration was unreadable."}
              />
            )}
          </Card>

          {/* Live now */}
          <Card>
            <CardHeader
              title="Live now"
              answers="Calls the switch currently sees, whether or not the agent picked up."
              icon={<PhoneIcon size={14} />}
            />
            {liveError ? (
              <p className="mb-3 text-sm text-amber-300">The engine is not answering: {liveError}</p>
            ) : null}
            {recorded.length === 0 ? (
              <EmptyState
                title="No calls in progress"
                description="As calls arrive they appear here, with the number, the agent bound to it and the path the call took."
              />
            ) : (
              <ul className="divide-y divide-white/[0.05]">
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
                        {record.disposition.replace(/_/g, " ")} · {describePath(record.handoffs)}
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
          </Card>

          {/* The products this screen hands off to */}
          <Card className="lg:col-span-2">
            <CardHeader
              title="Build, administer, extend"
              answers="Every one of these is a labelled link into the product that owns it — this console points, it does not pretend to own them."
            />
            {launchers.length === 0 ? (
              <EmptyState
                title="No linked products are configured"
                description="A deployment can point these at Dograh, Workflow Studio, the Capstone dashboard and FreePBX."
              />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {launchers.map((launcher) => (
                  <a
                    key={launcher.id}
                    href={launcher.href}
                    target="_blank"
                    rel="noreferrer"
                    title={`${launcher.answers} — opens ${launcher.productName}`}
                    className="group rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 transition hover:border-brand-500/30 hover:bg-white/[0.04]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-white">{launcher.label}</span>
                      <span className="text-xs text-white/25 transition group-hover:text-brand-300">
                        ↗
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-white/40">{launcher.answers}</p>
                    <p className="mt-2 text-[10px] uppercase tracking-wide text-white/25">
                      opens {launcher.productName}
                    </p>
                  </a>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === "routing" && (
        <Card>
          <CardHeader
            title="Which agent answers"
            answers="A workflow is a property of the number: this is the same value the PBX reads when the call comes in."
          />
          {capstone.state !== "enabled" ? (
            <p className="text-sm text-amber-300">
              {capstone.state === "unknown"
                ? `Could not verify the interviews add-on (${capstone.reason}). Nothing is shown as off.`
                : "The interviews add-on is not enabled for this account."}
            </p>
          ) : lines.length === 0 ? (
            <EmptyState
              title="No active numbers yet"
              description="Add a number on the Phone Numbers screen and it will appear here for routing."
            />
          ) : (
            <ul className="space-y-2">
              {lines.map((line) => {
                const draft = drafts[line.did] ?? line.capstone_binding ?? "";
                const changed = draft.trim() !== (line.capstone_binding ?? "");
                return (
                  <li
                    key={line.did}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.06] px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-sm font-medium text-white">
                        {line.did}
                        {line.capstone_binding ? (
                          <Badge tone="success">
                            <CheckCircleIcon size={11} /> Answering
                          </Badge>
                        ) : (
                          <Badge tone="muted">Unbound</Badge>
                        )}
                      </p>
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
                        {activeAgents.map((agent) => (
                          <option key={agent.id} value={String(agent.id)}>
                            {agent.name}
                          </option>
                        ))}
                      </select>
                      <Button size="sm" disabled={busy || !changed} onClick={() => void saveBinding(line.did, draft.trim())}>
                        Save
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}

      {tab === "agents" && (
        <Card>
          <CardHeader
            title="Agents"
            answers="Exactly as the engine has them. Editing a prompt, a node or a branch happens in Dograh; this screen reads."
            actions={editUrl ? <Button size="sm" href={editUrl} external>Open Dograh ↗</Button> : undefined}
          />
          {agents.length === 0 ? (
            <EmptyState
              title="No agents on the voice engine yet"
              description="Create one in Dograh and it appears here with its run count and turn-taking settings."
              action={editUrl ? <Button size="sm" variant="primary" href={editUrl} external>Create in Dograh ↗</Button> : undefined}
            />
          ) : (
            <ul className="space-y-2">
              {agents.map((agent) => {
                const answering =
                  bound.has(String(agent.id)) || bound.has(agent.name);
                return (
                  <li
                    key={agent.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.06] px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 truncate text-sm font-medium text-white">
                        {agent.name}
                        {agent.status !== "active" ? (
                          <Badge tone="neutral">{agent.status}</Badge>
                        ) : null}
                        {answering ? (
                          <Badge tone="success">
                            <CheckCircleIcon size={11} /> Answering a line
                          </Badge>
                        ) : null}
                      </p>
                      <p className="truncate text-xs text-white/40">{turnSummary(agent.turn)}</p>
                    </div>
                    <span className="shrink-0 text-xs text-white/30">
                      {agent.total_runs ?? 0} call{agent.total_runs === 1 ? "" : "s"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}

      {tab === "calls" && (
        <Card>
          <CardHeader
            title="Recent calls"
            answers="The calls these agents handled, newest first — the outcome and where the call went."
          />
          {runs.length === 0 ? (
            <EmptyState
              title="No calls yet"
              description="None of the agents bound to this account's numbers has handled a call."
            />
          ) : (
            <ul className="divide-y divide-white/[0.05]">
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
        </Card>
      )}
    </div>
  );
}
