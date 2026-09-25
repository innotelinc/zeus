import Link from "next/link";
import { requireDashboardUser } from "@/lib/dashboard-auth";
import { addonStatus } from "@/lib/addons";
import { dograhConfigured } from "@/lib/dograh";
import { loadVoiceConsole } from "@/lib/voice-console";
import { proxiedLaunchers } from "@/lib/console";
import { describeOutcome, describeTurn } from "@/lib/voice-labels";
import { fmtDate } from "@/lib/client-api";
import AddonGate from "@/components/dashboard/AddonGate";
import {
  SparklesIcon,
  FileTextIcon,
  CheckCircleIcon,
  PhoneIcon,
} from "@/components/icons";
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader, Stat } from "@/components/ui";

export const dynamic = "force-dynamic";

export const metadata = { title: "Agents & Workflows — Zeus" };

/**
 * Agents & workflows — the roster and its calls.
 *
 * This is the merged home of what the Capstone dashboard called *Agents* and
 * *Workflows*, in the shape the routing actually has: an agent **is** a Dograh
 * workflow. It lists them exactly as the engine has them — status, turn-taking,
 * run count, whether a number reaches it — and lets each one be opened in
 * Dograh to edit, rather than re-implementing Dograh's builder here.
 *
 * The calls are the workflows these account's numbers reach, scoped by
 * binding: the engine's run list is estate-wide, and one customer seeing all of
 * it is a data leak, not a feature.
 */
export default async function WorkflowsPage() {
  const user = await requireDashboardUser();
  const addon = await addonStatus("agents", { user: user.email });

  if (addon.state !== "enabled") {
    return <AddonGate sku="agents" state={addon.state} reason={addon.reason} />;
  }

  if (!dograhConfigured()) {
    return (
      <AddonGate
        sku="agents"
        state="unknown"
        mode="deployment"
        reason="the voice engine is not configured on this deployment"
      />
    );
  }

  const data = await loadVoiceConsole(user.id);
  const editUrl = proxiedLaunchers(["dograh"]).find((l) => l.id === "workflows")?.href ?? null;

  const active = data.agents.filter((agent) => agent.status === "active");
  const bound = new Set(data.lines.map((line) => line.capstone_binding).filter(Boolean));
  const boundCount = data.lines.filter((line) => line.capstone_binding).length;
  const totalRuns = data.agents.reduce((sum, agent) => sum + (agent.total_runs ?? 0), 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Agents & workflows"
        icon={<SparklesIcon size={20} className="text-brand-300" />}
        description="Your Dograh agents, exactly as the engine has them, with the calls they handled. Editing a prompt, a node or a branch happens in Dograh — this screen reads."
        actions={
          editUrl ? (
            <Button size="sm" variant="primary" href={editUrl} external>
              Open Dograh ↗
            </Button>
          ) : undefined
        }
      />

      {data.agentsState !== "ok" ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          {data.agentsError ?? "The voice engine could not be read."}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Agents" value={data.agents.length} hint={`${active.length} active`} />
        <Stat
          label="Lines answering"
          value={`${boundCount}/${data.lines.length}`}
          hint="numbers bound to an agent"
          icon={<PhoneIcon size={13} />}
        />
        <Stat label="Calls handled" value={totalRuns} hint="across all agents" />
        <Stat
          label="Shown calls"
          value={data.runs.length}
          hint="on this account's lines"
          icon={<FileTextIcon size={13} />}
        />
      </div>

      {/* ── The roster ─────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Agents"
          answers="Each workflow with its turn-taking and the calls it has handled."
        />
        {data.agents.length === 0 ? (
          <EmptyState
            title="No agents on the voice engine yet"
            description="Create one in Dograh and it appears here with its run count and turn-taking settings."
            action={
              editUrl ? (
                <Button size="sm" variant="primary" href={editUrl} external>
                  Create in Dograh ↗
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="space-y-2">
            {data.agents.map((agent) => {
              const answering = bound.has(String(agent.id)) || bound.has(agent.name);
              return (
                <li
                  key={agent.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.06] px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 truncate text-sm font-medium text-white">
                      {agent.name}
                      {agent.status !== "active" ? <Badge tone="neutral">{agent.status}</Badge> : null}
                      {answering ? (
                        <Badge tone="success">
                          <CheckCircleIcon size={11} /> Answering a line
                        </Badge>
                      ) : null}
                    </p>
                    <p className="truncate text-xs text-white/40">{describeTurn(agent.turn)}</p>
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

      {/* ── The calls ──────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Recent calls"
          answers="The calls these agents handled, newest first — the outcome and where the call went."
        />
        {data.runs.length === 0 ? (
          <EmptyState
            title="No calls yet"
            description="None of the agents bound to this account's numbers has handled a call."
          />
        ) : (
          <ul className="divide-y divide-white/[0.05]">
            {data.runs.map((run) => {
              // A run whose call id is missing has no drill-down to open — the
              // portal's call store is keyed on that id. Rendered as a plain
              // row rather than a link that 404s.
              const body = (
                <>
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
                  {/* The id both products carry — what to search the engine, the
                      PBX log and the control panel by. */}
                  {run.call_id ? <span className="font-mono">{run.call_id}</span> : null}
                  {run.nodes_visited.length > 0 ? (
                    <span>{run.nodes_visited.length} step(s) reached</span>
                  ) : null}
                </div>
                </>
              );
              const classes = "block rounded-lg py-3 text-sm";
              return (
                <li key={`${run.workflow_id}-${run.id}`}>
                  {run.call_id ? (
                    <Link
                      href={`/dashboard/calls/${encodeURIComponent(run.call_id)}`}
                      className={`${classes} transition hover:bg-white/[0.03]`}
                    >
                      {body}
                    </Link>
                  ) : (
                    <div className={classes}>{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
