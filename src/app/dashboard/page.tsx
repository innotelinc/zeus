import Link from "next/link";
import { requireDashboardUser } from "@/lib/dashboard-auth";
import { getUserDashboard } from "@/lib/dashboard";
import { addonStatuses } from "@/lib/addons";
import { listVoiceCalls } from "@/lib/voice-calls";
import { describePath } from "@/lib/voice-labels";
import { fmtDate, fmtDuration, fmtTime, planLabel } from "@/lib/client-api";
import {
  PhoneIcon,
  MessageIcon,
  VoicemailIcon,
  HistoryIcon,
  SparklesIcon,
  FileTextIcon,
  HeartPulseIcon,
} from "@/components/icons";
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader, Stat } from "@/components/ui";

export const dynamic = "force-dynamic";

export const metadata = { title: "Today — Zeus" };

/** How many recent items each panel shows on the overview. */
const RECENT = 6;

/**
 * Today — the console's home.
 *
 * The estate has five products and six UIs, and until now the first screen was
 * a list of phone numbers: an operator arriving to answer "what is happening?"
 * had to know which screen held it. This page is the answer, one panel per
 * question — what arrived, what was called, and whether the machine is well —
 * with each panel a labelled link into the module that owns it.
 */
export default async function TodayPage() {
  const user = await requireDashboardUser();
  const dash = getUserDashboard(user.id);
  const statuses = await addonStatuses({ user: user.email });

  const addons = Object.fromEntries(statuses.map((status) => [status.sku, status.state]));
  const voice = statuses.find((status) => status.sku === "agents");

  const activeNumbers = dash.phone_numbers.filter((n) => n.status === "active");
  const unreadMessages = dash.conversations.reduce((sum, c) => sum + (c.unread_count ?? 0), 0);
  const newVoicemails = dash.voicemails.filter((v) => v.listened === 0);

  // The portal's own call record, written by the switch — the same store the
  // voice screens read, so the overview and the module cannot disagree.
  const calls = listVoiceCalls(50, user.id);
  const liveCalls = calls.filter((call) => !call.ended_at);
  const recentCalls = dash.recent_calls.slice(0, RECENT);
  const recentVoicemails = dash.voicemails.slice(0, 3);
  const recentThreads = dash.conversations.slice(0, 3);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Today"
        icon={<HistoryIcon size={20} className="text-brand-300" />}
        description={`What is happening on ${planLabel(user.plan)} right now — calls, what arrived, and how the machine is doing.`}
        actions={
          <Button size="sm" variant="primary" href="/dashboard/numbers" title="Buy or manage numbers">
            <PhoneIcon size={14} /> Phone numbers
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Numbers"
          value={activeNumbers.length}
          hint={`${dash.phone_numbers.length - activeNumbers.length} not active`}
          icon={<PhoneIcon size={13} />}
        />
        <Stat
          label="Extensions"
          value={dash.extensions.length}
          hint={`${dash.extensions.filter((e) => e.device_state === "available").length} online`}
          icon={<PhoneIcon size={13} />}
        />
        <Stat
          label="Unread messages"
          value={unreadMessages}
          hint={`${dash.conversations.length} conversations`}
          icon={<MessageIcon size={13} />}
        />
        <Stat
          label="New voicemail"
          value={newVoicemails.length}
          hint={`${dash.voicemails.length} in the inbox`}
          icon={<VoicemailIcon size={13} />}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* ── Calls ─────────────────────────────────────────────── */}
        <Card>
          <CardHeader
            title="Recent calls"
            answers="Every call the switch saw, with where it went."
            icon={<PhoneIcon size={14} />}
            actions={
              <Link href="/dashboard/history" className="text-xs text-brand-300 hover:text-brand-200">
                All history →
              </Link>
            }
          />
          {liveCalls.length > 0 ? (
            <p className="mb-3 flex items-center gap-2 text-sm text-mint-400">
              <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-mint-400" />
              {liveCalls.length} call{liveCalls.length === 1 ? "" : "s"} in progress
            </p>
          ) : null}
          {recentCalls.length === 0 ? (
            <EmptyState
              title="No calls yet"
              description="Calls appear here as soon as they are made or received on your extensions."
            />
          ) : (
            <ul className="divide-y divide-white/[0.05]">
              {recentCalls.map((call) => (
                <li key={call.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate text-white/75">
                      {call.caller_name ?? call.caller_number ?? "unknown"}
                    </span>
                    <span className="block text-xs text-white/35">
                      {fmtDate(call.created_at)}
                      {call.direction ? ` · ${call.direction}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-white/40">
                    {call.duration_seconds ? fmtDuration(call.duration_seconds) : call.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* ── Inbox ─────────────────────────────────────────────── */}
        <Card>
          <CardHeader
            title="Waiting for a person"
            answers="What arrived and needs a reply."
            icon={<MessageIcon size={14} />}
          />
          {recentVoicemails.length === 0 && recentThreads.length === 0 ? (
            <EmptyState
              title="Nothing waiting"
              description="Voicemails and unread messages land here the moment they arrive."
            />
          ) : (
            <ul className="space-y-3">
              {recentVoicemails.map((vm) => (
                <li key={vm.id} className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-white/75">
                      {vm.caller_name ?? vm.caller_id ?? "Unknown caller"}
                    </span>
                    <span className="block truncate text-xs text-white/35">
                      {vm.summary ?? vm.transcript ?? "Voicemail"}
                    </span>
                  </span>
                  {vm.listened === 0 ? <Badge tone="brand">New</Badge> : null}
                </li>
              ))}
              {recentThreads.map((thread) => (
                <li key={thread.id} className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-white/75">
                      {thread.contact_name ?? thread.contact_phone}
                    </span>
                    <span className="block truncate text-xs text-white/35">
                      {thread.last_message_text ?? "No messages"}
                    </span>
                  </span>
                  {thread.unread_count > 0 ? (
                    <Badge tone="brand">{thread.unread_count}</Badge>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex flex-wrap gap-3 text-xs">
            <Link href="/dashboard/voicemail" className="text-brand-300 hover:text-brand-200">
              Voicemail →
            </Link>
            <Link href="/dashboard/messages" className="text-brand-300 hover:text-brand-200">
              Messages →
            </Link>
            <Link href="/dashboard/fax" className="text-brand-300 hover:text-brand-200">
              Fax →
            </Link>
          </div>
        </Card>

        {/* ── The voice plane ───────────────────────────────────── */}
        {addons.agents === "enabled" ? (
          <Card>
            <CardHeader
              title="Your voice agent"
              answers="Which agent answers, and what it has handled."
              icon={<SparklesIcon size={14} />}
              actions={
                <Link href="/dashboard/voice" className="text-xs text-brand-300 hover:text-brand-200">
                  Open →
                </Link>
              }
            />
            <p className="text-sm text-white/60">
              Dograh answers your inbound calls.{" "}
              {liveCalls.length > 0
                ? `${liveCalls.length} call${liveCalls.length === 1 ? "" : "s"} in progress now.`
                : "No calls in progress."}
            </p>
            <div className="mt-3 flex flex-wrap gap-3 text-xs">
              <Link href="/dashboard/voice" className="text-brand-300 hover:text-brand-200">
                Routing &amp; live →
              </Link>
              <Link href="/dashboard/workflows" className="text-brand-300 hover:text-brand-200">
                Agents &amp; workflows →
              </Link>
              {addons.capstone === "enabled" ? (
                <Link href="/dashboard/capstone" className="text-brand-300 hover:text-brand-200">
                  Interviews →
                </Link>
              ) : null}
            </div>
          </Card>
        ) : null}

        {/* ── The machine ───────────────────────────────────────── */}
        <Card>
          <CardHeader
            title="The machine"
            answers="How the estate is doing, and where each fact lives."
            icon={<HeartPulseIcon size={14} />}
            actions={
              <Link href="/dashboard/health" className="text-xs text-brand-300 hover:text-brand-200">
                Health →
              </Link>
            }
          />
          <ul className="space-y-2">
            <li className="flex items-center justify-between gap-3 text-sm">
              <span className="text-white/60">Voice engine</span>
              {voice?.state === "enabled" ? (
                <Badge tone="success">configured</Badge>
              ) : voice?.state === "disabled" ? (
                <Badge tone="muted">add-on off</Badge>
              ) : (
                <Badge tone="warning">could not verify</Badge>
              )}
            </li>
            <li className="flex items-center justify-between gap-3 text-sm">
              <span className="text-white/60">Interviews</span>
              {addons.capstone === "enabled" ? (
                <Badge tone="success">on</Badge>
              ) : (
                <Badge tone="muted">off</Badge>
              )}
            </li>
            <li className="flex items-center justify-between gap-3 text-sm">
              <span className="text-white/60">Last call</span>
              <span className="text-xs text-white/40">
                {calls[0]?.started_at ? fmtTime(calls[0].started_at) : "—"}
              </span>
            </li>
            {calls[0] ? (
              <li className="text-xs text-white/35">Latest path: {describePath(calls[0].handoffs)}</li>
            ) : null}
          </ul>
          <div className="mt-4 flex flex-wrap gap-3 text-xs">
            <Link href="/dashboard/estate" className="text-brand-300 hover:text-brand-200">
              <FileTextIcon size={12} className="mr-1 inline" />
              System map →
            </Link>
            <Link href="/dashboard/health" className="text-brand-300 hover:text-brand-200">
              <HeartPulseIcon size={12} className="mr-1 inline" />
              Health →
            </Link>
          </div>
        </Card>
      </div>
    </div>
  );
}
