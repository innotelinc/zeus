import Link from "next/link";
import { notFound } from "next/navigation";
import { requireDashboardUser } from "@/lib/dashboard-auth";
import { addonStatus } from "@/lib/addons";
import { getVoiceCall, priorCallsForDid } from "@/lib/voice-calls";
import { findRunByCallId, loadAgents } from "@/lib/voice-console";
import { proxiedLaunchers } from "@/lib/console";
import { describeOutcome, describePath } from "@/lib/voice-labels";
import { fmtDateTime } from "@/lib/client-api";
import AddonGate from "@/components/dashboard/AddonGate";
import { PhoneIcon, SparklesIcon, FileTextIcon } from "@/components/icons";
import { Badge, Card, CardHeader, EmptyState, PageHeader, Stat } from "@/components/ui";

export const dynamic = "force-dynamic";

export const metadata = { title: "Call — Zeus" };

/**
 * One call, joined across products.
 *
 * The estate has two truth stores for a call — the switch's record and the
 * engine's run — and an operator asking "what happened on this call?" used to
 * have to know which product answered, and read both. `voice_calls` exists to
 * be the join: one row, keyed on the id every product already carries
 * (`docs/voice-convergence.md` §2.6). This screen is that row, spelled
 * out, with the engine's run and the transcript's handle beside it.
 *
 * Two boundaries are deliberate and stated on the page rather than hidden:
 *
 *   * **The transcript is the answering engine's, addressed by a signed token
 *     Capstone mints at call time**, which never passes through the portal. So
 *     the portal names the handle it really holds — the call id and the
 *     workflow — instead of inventing a link that 404s.
 *   * **A call the portal did not route is not shown.** The row is written from
 *     the channel's own AMI events, so a miss is "not one of ours", and a call
 *     with no account belongs to the estate, not to a customer.
 */
export default async function CallPage({
  params,
}: {
  params: Promise<{ callId: string }>;
}) {
  const { callId } = await params;
  const user = await requireDashboardUser();

  const call = getVoiceCall(callId);
  if (!call) notFound();

  // Ownership: a customer sees only their own calls. A call with no account id
  // was routed by the estate and belongs to staff; without this, any signed-in
  // user could read another account's call by guessing an id.
  const isStaff = user.role === "admin";
  if (call.account_id ? call.account_id !== user.id && !isStaff : !isStaff) notFound();

  const addon = await addonStatus("agents", { user: user.email });
  if (addon.state !== "enabled") {
    return <AddonGate sku="agents" state={addon.state} reason={addon.reason} />;
  }

  const { agents, state } = await loadAgents();
  const match = state === "ok" ? await findRunByCallId(callId, agents, call.capstone_binding) : null;
  const prior = call.did ? priorCallsForDid(call.did, callId) : null;
  const capstoneUrl = proxiedLaunchers(["capstone"]).find((l) => l.id === "capstone-dashboard")?.href ?? null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Call detail"
        icon={<PhoneIcon size={20} className="text-brand-300" />}
        description="One call, joined across the products that saw it — the switch's record, the engine's run, and where the transcript lives."
        actions={
          <Link href="/dashboard/history" className="text-xs text-brand-300 hover:text-brand-200">
            Back to history →
          </Link>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Number dialled" value={call.did ?? "—"} />
        <Stat
          label="State"
          value={call.ended_at ? "Finished" : "Live"}
          hint={call.disposition.replace(/_/g, " ")}
        />
        <Stat label="Hand-offs" value={call.handoffs.length} hint={describePath(call.handoffs)} />
        <Stat label="Prior calls" value={prior?.count ?? "—"} hint="to this number" />
      </div>

      {/* ── The switch's record ───────────────────────────────── */}
      <Card>
        <CardHeader
          title="The switch's record"
          answers="Written by the PBX from the channel's own events, so it exists even for a call no agent picked up."
          icon={<PhoneIcon size={14} />}
        />
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Field label="Call id" mono value={call.call_id} />
          <Field label="Account" value={call.account_id ? "this account" : "unassigned (estate call)"} />
          <Field label="Started" value={call.started_at ? fmtDateTime(call.started_at) : "—"} />
          <Field label="Ended" value={call.ended_at ? fmtDateTime(call.ended_at) : "still up"} />
          <Field
            label="Binding"
            value={call.capstone_binding ?? "no agent bound — transfers refuse to an operator"}
          />
          <Field
            label="Path"
            value={describePath(call.handoffs)}
          />
        </dl>
      </Card>

      {/* ── The engine's run ──────────────────────────────────── */}
      <Card>
        <CardHeader
          title="The engine's run"
          answers="The Dograh run that carries this call id — what the agent actually did."
          icon={<SparklesIcon size={14} />}
        />
        {match ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-white">{match.agent.name}</span>
              <Badge tone={match.run.is_completed ? "success" : "warning"}>
                {match.run.is_completed ? "completed" : "unfinished"}
              </Badge>
              {match.run.created_at ? (
                <span className="text-xs text-white/35">{fmtDateTime(match.run.created_at)}</span>
              ) : null}
            </div>
            <p className="mt-2 text-sm text-white/60">{describeOutcome(match.run.outcome)}</p>
            <dl className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <Field
                label="Duration"
                value={match.run.duration_seconds ? `${match.run.duration_seconds}s` : "—"}
              />
              <Field label="Nodes reached" value={String(match.run.nodes_visited.length)} />
              <Field
                label="Thinking model"
                value={match.run.llm_model ?? "not reported"}
                mono
              />
              <Field
                label="Speaking with"
                value={[match.run.tts_provider, match.run.tts_model].filter(Boolean).join(" / ") || "not reported"}
                mono
              />
            </dl>
            {match.run.nodes_visited.length > 0 ? (
              <p className="mt-3 text-xs text-white/40">
                {match.run.nodes_visited.join(" → ")}
              </p>
            ) : null}
          </>
        ) : (
          <EmptyState
            icon={<SparklesIcon size={26} />}
            title={state === "ok" ? "No engine run carries this call id" : "The engine could not be read"}
            description={
              state === "ok"
                ? "The switch saw the call, but no Dograh run recorded it — the call may have been answered by the dialplan alone, or the engine's run is older than the window this screen searches."
                : "Dograh is unreachable or not configured, so the run behind this call could not be looked up."
            }
          />
        )}
      </Card>

      {/* ── The transcript ────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="The transcript"
          answers="Capstone files one per interview run, behind a signed token it mints at call time."
          icon={<FileTextIcon size={14} />}
        />
        {call.capstone_binding ? (
          <p className="text-sm text-white/60">
            This call reached <span className="font-mono text-white/80">{call.capstone_binding}</span>.
            The transcript belongs to Capstone, and the portal does not hold its download token —
            the handle both products share is the call id and the workflow, which is what to search
            Capstone by.
          </p>
        ) : (
          <p className="text-sm text-white/50">
            No interview was reached on this call, so there is no Capstone transcript for it.
          </p>
        )}
        {capstoneUrl ? (
          <a
            href={capstoneUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-4 inline-flex text-sm text-brand-300 hover:text-brand-200"
          >
            Open the Capstone dashboard ↗
          </a>
        ) : null}
      </Card>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-white/35">{label}</dt>
      <dd className={`mt-0.5 truncate text-sm text-white/75 ${mono ? "font-mono" : ""}`}>
        {value}
      </dd>
    </div>
  );
}
