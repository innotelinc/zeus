import Link from "next/link";
import { requireDashboardUser } from "@/lib/dashboard-auth";
import { addonStatus } from "@/lib/addons";
import db from "@/lib/db";
import AddonGate from "@/components/dashboard/AddonGate";
import { FileTextIcon } from "@/components/icons";

export const dynamic = "force-dynamic";

interface NumberRow {
  did: string;
}

/**
 * Capstone interviews, as the account sees them.
 *
 * This is the hand-off end of the voice plane: AVA answers, and when the
 * caller wants to be interviewed the agent transfers to Capstone, which
 * screens them and files the transcript. Two things have to be true for that
 * to happen — the account holds the add-on here, and the router stamped the
 * same account ZEUS_CAPSTONE_ADDON=1 on the channel (see
 * pbx/ava_routing.py). The gate below is therefore both the UI decision and
 * a preview of the routing decision.
 */
export default async function CapstonePage() {
  const user = await requireDashboardUser();
  const addon = await addonStatus("capstone", { user: user.email });

  if (addon.state !== "enabled") {
    return <AddonGate sku="capstone" state={addon.state} reason={addon.reason} />;
  }

  const numbers = db
    .prepare("SELECT did FROM phone_numbers WHERE user_id = ? AND status = 'active' ORDER BY did")
    .all(user.id) as NumberRow[];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-white">
          <FileTextIcon size={20} className="text-brand-300" />
          Capstone interviews
        </h1>
        <p className="mt-1 text-sm text-white/50">
          Calls your voice agent hands off are screened by Capstone and filed as a
          transcript.
        </p>
      </header>

      <section className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white/40">
          Hand-off destination
        </h2>
        <p className="mt-3 text-sm text-white/60">
          Extension <span className="font-mono text-white">824</span> — the interview agent.
          Your voice agent can reach it during a call; nothing else on the system can.
        </p>
        <p className="mt-2 text-xs text-white/40">
          Enforced in the PBX dialplan, not just in the agent&apos;s prompt: a call is
          refused when the add-on is not active on the channel.
        </p>
      </section>

      <section className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white/40">
          Numbers that can hand off
        </h2>
        {numbers.length === 0 ? (
          <p className="mt-3 text-sm text-white/40">
            No active numbers yet — add one from{" "}
            <Link href="/dashboard" className="text-brand-300 hover:text-brand-200">
              Phone Numbers
            </Link>
            .
          </p>
        ) : (
          <ul className="mt-3 flex flex-wrap gap-2">
            {numbers.map((n) => (
              <li
                key={n.did}
                className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 font-mono text-sm text-white/70"
              >
                {n.did}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
