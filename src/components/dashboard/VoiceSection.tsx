"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, fmtDate } from "@/lib/client-api";
import {
  SparklesIcon,
  PhoneIcon,
  RefreshIcon,
  CheckCircleIcon,
  AlertCircleIcon,
} from "@/components/icons";
import { useToast } from "@/components/ToastProvider";
import { Badge, Dot, Button, Card, CardHeader, EmptyState, PageHeader, Stat, Tabs } from "@/components/ui";
// `import type` is erased entirely at compile time, so these shapes reach the
// browser without pulling `lib/dograh.ts` — and the API key it reads — into the
// client bundle.
import type { DograhTurnConfig, DograhVoiceStack, DograhWorkflow } from "@/lib/dograh";
import type { ProxiedLauncher } from "@/lib/console";
import { describePath } from "@/lib/voice-labels";
import type { InterviewLine } from "@/lib/voice-bindings";

/** One agent, as this screen needs it: the workflow plus how it takes turns. */
export interface AgentRow extends DograhWorkflow {
  turn: DograhTurnConfig | null;
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

/**
 * The voice screen — the plan and the present.
 *
 * It answers two questions and no more: *which agent answers which number*
 * (the routing plan) and *what is happening now*. The agents themselves and
 * their calls live on `/dashboard/workflows`, because a screen that shows the
 * plan, the roster and the runs at once is how "which of these is the one that
 * matters?" starts.
 */
export default function VoiceSection({
  agents,
  agentsState,
  agentsError,
  voice,
  voiceError,
  lines: initialLines,
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
  const editUrl = launchers.find((launcher) => launcher.id === "workflows")?.href ?? null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Voice agents"
        icon={<SparklesIcon size={20} className="text-brand-300" />}
        description="Dograh answers your calls and runs the conversations. This screen is the plan — which agent answers which number — and what is happening live. The agents themselves are on Agents & workflows."
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
      <div className="grid gap-3 sm:grid-cols-3">
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
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "routing", label: "Routing", count: boundCount },
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
                  <li key={record.call_id}>
                    {/* The row opens the call's detail — the id both products
                        carry is what the drill-down joins on. */}
                    <Link
                      href={`/dashboard/calls/${encodeURIComponent(record.call_id)}`}
                      className="block rounded-lg py-2 text-sm transition hover:bg-white/[0.03]"
                    >
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
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* The agents and their calls now have their own home. */}
          <Card className="lg:col-span-2">
            <CardHeader
              title="The agents behind the plan"
              answers="The workflows themselves, with their turn-taking and their calls."
              actions={
                <Link href="/dashboard/workflows" className="text-xs text-brand-300 hover:text-brand-200">
                  Agents &amp; workflows →
                </Link>
              }
            />
            <p className="text-sm text-white/50">
              {agents.length === 0
                ? "No agents on the voice engine yet."
                : `${agents.length} agent${agents.length === 1 ? "" : "s"} on the engine${
                    bound.size > 0 ? `, ${bound.size} answering a line` : ""
                  }.`}{" "}
              Read their prompts, turn-taking and calls there — or build a new flow in Dograh.
            </p>
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
    </div>
  );
}
