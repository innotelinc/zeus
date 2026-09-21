"use client";

import { useCallback, useEffect, useState } from "react";
import { api, fmtDate } from "@/lib/client-api";
import { SparklesIcon, PhoneIcon, RefreshIcon, PlusIcon, CheckCircleIcon } from "@/components/icons";
import { useToast } from "@/components/ToastProvider";
import type { AvaAgent, AvaCall } from "@/lib/ava";

interface Props {
  agents: AvaAgent[];
  calls: AvaCall[];
  /** Slug currently answering this account's calls, if set. */
  mappedAgent: string | null;
  avaState: string;
}

interface LiveCall {
  caller_number?: string | null;
  from_number?: string | null;
  agent_slug?: string | null;
  state?: string | null;
  duration_seconds?: number | null;
}

const POLL_MS = 10_000;

export default function VoiceSection({
  agents: initialAgents,
  calls,
  mappedAgent: initialMapped,
  avaState,
}: Props) {
  const { toast } = useToast();
  const [agents, setAgents] = useState(initialAgents);
  const [mapped, setMapped] = useState(initialMapped);
  const [live, setLive] = useState<LiveCall[]>([]);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newAgent, setNewAgent] = useState({ slug: "", display_name: "", prompt: "" });

  const poll = useCallback(async () => {
    try {
      const data = (await api("/api/voice/live")) as {
        active?: LiveCall[];
        error?: string;
      };
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
