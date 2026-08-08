import { getCurrentUser } from "@/lib/auth";
import { getUserDashboard } from "@/lib/dashboard";
import { fmtDate, fmtDuration } from "@/lib/client-api";
import { HistoryIcon, PhoneIcon } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function CallHistoryPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const dash = getUserDashboard(user.id);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">Call History</h1>
        <p className="mt-1 text-sm text-white/45">Recent calls on your extensions.</p>
      </div>

      {dash.recent_calls.length === 0 ? (
        <div className="card-surface flex flex-col items-center rounded-3xl p-10 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-white/[0.05] text-white/30">
            <HistoryIcon size={30} />
          </div>
          <h3 className="mt-5 text-lg font-semibold text-white">No calls yet</h3>
          <p className="mt-2 max-w-md text-sm text-white/45">
            Call history will appear here once calls are made or received on
            your extensions.
          </p>
        </div>
      ) : (
        <div className="card-surface overflow-hidden rounded-2xl">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                  <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-white/40">Direction</th>
                  <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-white/40">Caller</th>
                  <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-white/40">Number</th>
                  <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-white/40">Duration</th>
                  <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-white/40">Date</th>
                  <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-white/40">Status</th>
                </tr>
              </thead>
              <tbody>
                {dash.recent_calls.map((call) => (
                  <tr
                    key={call.id}
                    className="border-b border-white/[0.04] transition hover:bg-white/[0.02]"
                  >
                    <td className="px-5 py-3">
                      <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        call.direction === "inbound"
                          ? "bg-mint-500/10 text-mint-400"
                          : call.direction === "outbound"
                            ? "bg-brand-500/10 text-brand-300"
                            : "bg-white/[0.05] text-white/50"
                      }`}>
                        <PhoneIcon size={12} />
                        {call.direction}
                      </span>
                    </td>
                    <td className="px-5 py-3 font-medium text-white">
                      {call.caller_name ?? "—"}
                    </td>
                    <td className="px-5 py-3 font-mono text-white/60">
                      {call.direction === "outbound" ? call.callee_number : call.caller_number}
                    </td>
                    <td className="px-5 py-3 text-white/40">
                      {fmtDuration(call.duration_seconds)}
                    </td>
                    <td className="px-5 py-3 text-white/35">
                      {fmtDate(call.created_at)}
                    </td>
                    <td className="px-5 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        call.status === "completed"
                          ? "bg-mint-500/10 text-mint-400"
                          : "bg-white/[0.05] text-white/40"
                      }`}>
                        {call.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
