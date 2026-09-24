"use client";

import { useCallback, useEffect, useState } from "react";
import { api, fmtDate } from "@/lib/client-api";
import { SparklesIcon, PhoneIcon, RefreshIcon, PlusIcon, CheckCircleIcon } from "@/components/icons";
import { useToast } from "@/components/ToastProvider";
import { INTERVIEW_AGENT_PROMPT } from "@/lib/agent-prompts";
import type { AvaAgent, AvaCall } from "@/lib/ava";
import type { InterviewLine } from "@/lib/voice-bindings";

interface Props {
  agents: AvaAgent[];
  calls: AvaCall[];
  /** Slug currently answering this account's calls, if set. */
  mappedAgent: string | null;
  avaState: string;
  /** This account's numbers and the Capstone workflow each reaches. */
  lines: InterviewLine[];
  /** The Capstone add-on's state for this account, as the routing path sees it. */
  capstone: { state: string; reason: string };
}

interface LiveCall {
  caller_number?: string | null;
  from_number?: string | null;
  agent_slug?: string | null;
  state?: string | null;
  duration_seconds?: number | null;
}

/**
 * One `voice_calls` row, as `/api/voice/live` serves it (P4).
 *
 * Deliberately a mirror of the API's shape rather than an import of the server
 * module: this is a client component, and the server module reaches the
 * database.
 */
interface CallRecord {
  call_id: string;
  account_id: string | null;
  did: string | null;
  agent_slug: string | null;
  capstone_binding: string | null;
  started_at: string;
  disposition: string;
  handoffs: Array<{ to: string; at: string }>;
}

/** The path a call took, in the operator's words. */
function pathLabel(record: CallRecord): string {
  if (record.handoffs.length === 0) return "no hand-off";
  const hops = [record.agent_slug ?? "agent", ...record.handoffs.map((hop) => hop.to)];
  return hops.join(" → ");
}

/**
 * Did this call reach Capstone? The switch's own hand-off list is the evidence,
 * so the transcript handle is offered on what *happened*, not on what the
 * account is merely entitled to do.
 *
 * Capstone keys a transcript by its workflow run and a signed token it mints at
 * call time, neither of which the portal holds — so this is a **handle**, not a
 * link: the call id an operator searches Capstone (or the grader's Grist sheet)
 * by, plus the workflow that answered. It is the same key the context read
 * publishes (`capstone_transcript`), so the screen and the API name one thing.
 */
function reachedCapstone(record: CallRecord): boolean {
  return record.handoffs.some((hop) => hop.to === "capstone");
}

const POLL_MS = 10_000;

export default function VoiceSection({
  agents: initialAgents,
  calls,
  mappedAgent: initialMapped,
  avaState,
  lines: initialLines,
  capstone,
}: Props) {
  const { toast } = useToast();
  const [agents, setAgents] = useState(initialAgents);
  const [mapped, setMapped] = useState(initialMapped);
  const [lines, setLines] = useState(initialLines);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [live, setLive] = useState<LiveCall[]>([]);
  const [recorded, setRecorded] = useState<CallRecord[]>([]);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newAgent, setNewAgent] = useState({ slug: "", display_name: "", prompt: "" });

  const poll = useCallback(async () => {
    try {
      const data = (await api("/api/voice/live")) as {
        active?: LiveCall[];
        recorded?: CallRecord[];
        error?: string;
      };
      // The portal's own record is kept even on the engine's error path: it is
      // written by the switch, so a borked engine is precisely when an operator
      // wants to see which calls are still up.
      setRecorded(data.recorded ?? []);
      if (data.error) {
        // A broken engine must not look like a quiet one.
        setLiveError(data.error);
        setLive([]);
        return;
      }
      setLiveError(null);
      setLive(data.active ?? []);
    } catch (e) {
      setLiveError(e instanceof Error ? e.message : "Live status unavailable");
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

  async function mapAgent(slug: string) {
    setBusy(true);
    try {
      await api("/api/voice/agent-mapping", {
        method: "PUT",
        body: JSON.stringify({ agent_slug: slug }),
      });
      setMapped(slug);
      toast.success(`Calls are now answered by “${slug}”.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change the agent");
    } finally {
      setBusy(false);
    }
  }

  /**
   * One number's interview workflow. The add-on gate, the number's ownership
   * and the target's charset are all enforced server-side — this only reports
   * what the API said, so the UI cannot accept a value the PBX would refuse.
   */
  async function saveBinding(did: string, value: string) {
    setBusy(true);
    try {
      const data = (await api("/api/voice/agent-mapping", {
        method: "PUT",
        body: JSON.stringify({ did, capstone_binding: value }),
      })) as { lines?: InterviewLine[] };
      setLines(data.lines ?? lines);
      setDrafts((prev) => ({ ...prev, [did]: "" }));
      toast.success(
        value
          ? `Hand-offs from ${did} now reach workflow ${value}.`
          : `Hand-offs from ${did} will refuse to an operator.`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change the interview line");
    } finally {
      setBusy(false);
    }
  }

  async function createAgent(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/api/voice/agents", {
        method: "POST",
        body: JSON.stringify(newAgent),
      });
      const refreshed = (await api("/api/voice/agents")) as { agents: AvaAgent[] };
      setAgents(refreshed.agents ?? []);
      setShowCreate(false);
      setNewAgent({ slug: "", display_name: "", prompt: "" });
      toast.success("Agent created.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create the agent");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-white">
            <SparklesIcon size={20} className="text-brand-300" />
            Voice agent
          </h1>
          <p className="mt-1 text-sm text-white/50">
            AVA answers your inbound calls, runs the IVR, and transfers to your team.
          </p>
        </div>
        <button
          type="button"
          onClick={poll}
          className="inline-flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-white/60 transition hover:bg-white/[0.06] hover:text-white"
        >
          <RefreshIcon size={16} /> Refresh
        </button>
      </header>

      {avaState !== "ok" && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          The voice engine reported <strong>{avaState}</strong>. Calls may not be answered
          until it is healthy.
        </div>
      )}

      {/* ── Live calls ─────────────────────────────────────────── */}
      <section className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-white/40">
          <PhoneIcon size={16} /> Live now
        </h2>
        {liveError ? (
          <p className="mt-3 text-sm text-amber-300">Live status unavailable: {liveError}</p>
        ) : live.length === 0 ? (
          <p className="mt-3 text-sm text-white/40">No calls in progress.</p>
        ) : (
          <ul className="mt-3 divide-y divide-white/[0.05]">
            {live.map((call, i) => (
              <li key={i} className="flex items-center justify-between py-2 text-sm">
                <span className="text-white/70">
                  {call.caller_number ?? call.from_number ?? "Unknown caller"}
                </span>
                <span className="text-white/40">
                  {call.agent_slug ?? "agent"} · {call.state ?? "in progress"}
                </span>
              </li>
            ))}
          </ul>
        )}

        {/*
          The portal's own record, beside the engine's list on purpose. They
          answer different questions: the engine only knows the calls whose media
          it is carrying, while these rows exist from the moment the dialplan
          stamped the channel — so a call that has been handed to Capstone is
          absent from the list above and present here, which is exactly the call
          an operator is looking for. Written by the switch (AMI), never by the
          agents, so it survives an agent that dies mid-interview.
        */}
        <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-white/30">
          Call record
        </h3>
        {recorded.length === 0 ? (
          <p className="mt-2 text-sm text-white/40">
            No calls have reached the voice plane yet.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-white/[0.05]">
            {recorded.map((record) => (
              <li key={record.call_id} className="py-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-white/70">
                    {record.did ?? "unknown number"}
                    {record.capstone_binding ? (
                      <span className="text-white/40"> · interview {record.capstone_binding}</span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-white/40">
                    {record.disposition.replace("_", " ")} · {pathLabel(record)}
                  </span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-white/30">
                  {/* The id both products carry — the thing to quote in a log search. */}
                  <span className="font-mono">{record.call_id}</span>
                  <span>started {fmtDate(record.started_at)}</span>
                  {reachedCapstone(record) ? (
                    <span
                      className="text-white/45"
                      title={
                        "Capstone owns this call's transcript. Find the workflow run by " +
                        "this call id — the portal never receives Capstone's signed token."
                      }
                    >
                      Capstone transcript · workflow {record.capstone_binding ?? "unknown"}
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Agents ─────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-white/40">
            Agents
          </h2>
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="inline-flex items-center gap-1.5 text-sm text-brand-300 transition hover:text-brand-200"
          >
            <PlusIcon size={16} /> New agent
          </button>
        </div>

        {showCreate && (
          <form onSubmit={createAgent} className="mt-4 space-y-3 rounded-xl border border-white/[0.06] p-4">
            <input
              className="w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-white placeholder:text-white/30"
              placeholder="slug (lowercase, e.g. receptionist)"
              value={newAgent.slug}
              onChange={(e) => setNewAgent({ ...newAgent, slug: e.target.value })}
              required
            />
            <input
              className="w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-white placeholder:text-white/30"
              placeholder="Display name"
              value={newAgent.display_name}
              onChange={(e) => setNewAgent({ ...newAgent, display_name: e.target.value })}
              required
            />
            <textarea
              className="h-28 w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-white placeholder:text-white/30"
              placeholder="What should this agent do? The prompt shapes every call."
              value={newAgent.prompt}
              onChange={(e) => setNewAgent({ ...newAgent, prompt: e.target.value })}
              required
            />
            {/*
              The interview template, offered rather than assumed: an empty box
              and a blank prompt are not the same thing to AVA, and an operator
              who does not want it can edit whatever is inserted. Seeding the
              prompt is what makes the interview line sound like an interview
              line instead of a generic front desk (lib/agent-prompts.ts).
            */}
            <button
              type="button"
              disabled={busy}
              onClick={() => setNewAgent({ ...newAgent, prompt: INTERVIEW_AGENT_PROMPT })}
              className="text-xs text-brand-300 underline-offset-2 transition hover:text-brand-200 hover:underline disabled:opacity-50"
            >
              Use the interview-line template
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-brand-500/90 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-500 disabled:opacity-50"
            >
              {busy ? "Creating…" : "Create agent"}
            </button>
          </form>
        )}

        <ul className="mt-4 space-y-2">
          {agents.length === 0 && (
            <li className="text-sm text-white/40">
              No agents yet. Create one to start answering calls.
            </li>
          )}
          {agents.map((agent) => (
            <li
              key={agent.slug}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.06] px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-white">
                  {agent.display_name ?? agent.slug}
                </p>
                <p className="truncate text-xs text-white/40">
                  {agent.role_label ?? "voice agent"} · {agent.provider ?? "default provider"}
                </p>
              </div>
              {mapped === agent.slug ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-mint-400">
                  <CheckCircleIcon size={14} /> Answering your calls
                </span>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => mapAgent(agent.slug)}
                  className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-xs text-white/70 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-50"
                >
                  Use for my calls
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {/* ── Interview line ─────────────────────────────────────── */}
      <section className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white/40">
          Interview line
        </h2>
        <p className="mt-2 text-sm text-white/50">
          A hand-off from AVA sends the call to one Capstone interview workflow, and
          which one is a property of the number — so it is chosen per line. The value is
          the workflow&rsquo;s extension in Capstone; a workflow this PBX cannot reach
          refuses to an operator instead of guessing.
        </p>

        {capstone.state !== "enabled" ? (
          <p className="mt-3 text-sm text-amber-300">
            {capstone.state === "unknown"
              ? `Could not verify the Capstone interviews add-on (${capstone.reason}). Nothing is shown as off.`
              : "The Capstone interviews add-on is not enabled for this account."}
          </p>
        ) : lines.length === 0 ? (
          <p className="mt-3 text-sm text-white/40">
            No active numbers on this account yet.
          </p>
        ) : (
          <ul className="mt-4 space-y-2">
            {lines.map((line) => {
              const draft = drafts[line.did] ?? line.capstone_binding ?? "";
              return (
                <li
                  key={line.did}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.06] px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-white">{line.did}</p>
                    <p className="truncate text-xs text-white/40">
                      {line.capstone_binding
                        ? `hand-offs reach workflow ${line.capstone_binding}`
                        : "no interview workflow — hand-offs refuse to an operator"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      aria-label={`Capstone workflow for ${line.did}`}
                      className="w-44 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-sm text-white placeholder:text-white/30"
                      placeholder="workflow extension"
                      value={draft}
                      onChange={(e) =>
                        setDrafts((prev) => ({ ...prev, [line.did]: e.target.value }))
                      }
                    />
                    <button
                      type="button"
                      disabled={busy || draft.trim() === (line.capstone_binding ?? "")}
                      onClick={() => saveBinding(line.did, draft.trim())}
                      className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-xs text-white/70 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-40"
                    >
                      Save
                    </button>
                    {line.capstone_binding && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => saveBinding(line.did, "")}
                        className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-xs text-white/50 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-40"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── Recent calls ───────────────────────────────────────── */}
      <section className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white/40">
          Recent calls
        </h2>
        {calls.length === 0 ? (
          <p className="mt-3 text-sm text-white/40">No calls answered yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-white/[0.05]">
            {calls.map((call, i) => (
              <li key={call.record_id ?? call.id ?? i} className="py-3">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-white/70">
                    {call.caller_number ?? call.from_number ?? "Unknown caller"}
                  </span>
                  <span className="text-white/40">
                    {call.started_at ? fmtDate(call.started_at) : ""}
                    {call.duration_seconds ? ` · ${call.duration_seconds}s` : ""}
                  </span>
                </div>
                {(call.summary ?? call.outcome) && (
                  <p className="mt-1 text-xs text-white/50">{call.summary ?? call.outcome}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
