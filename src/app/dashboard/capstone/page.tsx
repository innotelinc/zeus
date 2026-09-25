import Link from "next/link";
import { requireDashboardUser } from "@/lib/dashboard-auth";
import { addonStatus } from "@/lib/addons";
import { accountLines } from "@/lib/voice-bindings";
import { listVoiceCalls, type VoiceCall } from "@/lib/voice-calls";
import { describeHandoffTarget, describePath } from "@/lib/voice-labels";
import AddonGate from "@/components/dashboard/AddonGate";
import { FileTextIcon, PhoneIcon } from "@/components/icons";
import { Badge, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { fmtDateTime } from "@/lib/client-api";

export const dynamic = "force-dynamic";

export const metadata = { title: "Interviews — Zeus" };

/** How many recent hand-offs the screen lists. */
const RECENT_LIMIT = 12;

/**
 * Interviews — the hand-off end of the voice plane.
 *
 * Dograh answers the call, and when the caller is screened the agent hands the
 * call to Capstone's interview context. This screen is the account's view of
 * that leg: which numbers can hand off, and what actually did.
 *
 * It reads the portal's own `voice_calls` store — filled by the switch's AMI
 * events — rather than calling an engine endpoint. That is deliberate on two
 * counts: the store records a call whether or not any agent picked it up, and
 * it survives the engine being down, which is exactly when an operator wants to
 * know what is in flight.
 */
export default async function InterviewsPage() {
  const user = await requireDashboardUser();
  const addon = await addonStatus("capstone", { user: user.email });

  if (addon.state !== "enabled") {
    return <AddonGate sku="capstone" state={addon.state} reason={addon.reason} />;
  }

  const lines = accountLines(user.id);
  const routed = lines.filter((line) => line.capstone_binding).length;

  // A hand-off is any call the switch saw move — either to Capstone or back.
  const handoffs: VoiceCall[] = listVoiceCalls(200, user.id)
    .filter((call) => call.handoffs.length > 0 || call.disposition !== "in_progress")
    .slice(0, RECENT_LIMIT);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Interviews"
        icon={<FileTextIcon size={20} className="text-brand-300" />}
        description="Calls your voice agent hands off are screened by Capstone and filed as a transcript. This is where that leg of each call is recorded."
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardHeader
            title="Hand-off destination"
            answers="Enforced in the PBX dialplan, not just in the agent's prompt."
          />
          <p className="text-sm text-white/60">
            Context <span className="font-mono text-white">dograh-inbound</span> — the interview
            agent. Your voice agent reaches it during a call; nothing else on the system can.
          </p>
          <p className="mt-2 text-xs text-white/40">
            A call is refused to an operator when the interviews add-on is not active on the
            channel, so the dialplan and this screen are the same decision.
          </p>
        </Card>

        <Card>
          <CardHeader
            title="Numbers that can hand off"
            answers={`${routed} of ${lines.length} active number(s) bound to an agent.`}
            icon={<PhoneIcon size={14} />}
          />
          {lines.length === 0 ? (
            <EmptyState
              title="No active numbers yet"
              description="Add a number from Phone Numbers, then choose the agent that answers it on the Voice Agents screen."
              action={
                <Link href="/dashboard" className="text-sm text-brand-300 hover:text-brand-200">
                  Phone Numbers →
                </Link>
              }
            />
          ) : (
            <ul className="space-y-2">
              {lines.map((line) => (
                <li
                  key={line.did}
                  className="flex items-center justify-between gap-3 border-b border-white/[0.04] pb-2 last:border-0 last:pb-0"
                >
                  <span className="font-mono text-sm text-white/70">{line.did}</span>
                  {line.capstone_binding ? (
                    <Badge tone="success">reaches {line.capstone_binding}</Badge>
                  ) : (
                    <Badge tone="muted">no agent bound</Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* ── What actually moved ────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Recent hand-offs"
          answers="Every call the switch saw move to Capstone or back, newest first. The record is written by the switch, so it survives an engine restart."
        />
        {handoffs.length === 0 ? (
          <EmptyState
            title="No calls have been handed off yet"
            description="A call appears here the moment the agent moves it to the interview context — or back to the agent."
          />
        ) : (
          <ul className="divide-y divide-white/[0.05]">
            {handoffs.map((call) => (
              <li key={call.call_id} className="py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-white/70">{call.did ?? "unknown number"}</span>
                  <span className="flex items-center gap-2 text-white/40">
                    {call.disposition.replace(/_/g, " ")}
                  </span>
                </div>
                <p className="mt-1 text-xs text-white/50">{describePath(call.handoffs)}</p>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-white/30">
                  <span className="font-mono">{call.call_id}</span>
                  <span>started {fmtDateTime(call.started_at)}</span>
                  {call.capstone_binding ? <span>binding {call.capstone_binding}</span> : null}
                  {call.handoffs.length > 0 ? (
                    <span>
                      last hop {describeHandoffTarget(call.handoffs[call.handoffs.length - 1].to)}
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
