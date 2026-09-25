import { requireDashboardUser } from "@/lib/dashboard-auth";
import { getUserDashboard } from "@/lib/dashboard";
import { fmtDate, fmtDuration } from "@/lib/client-api";
import { HistoryIcon, PhoneIcon } from "@/components/icons";
import { Badge, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export const metadata = { title: "Call History — Zeus" };

export default async function CallHistoryPage() {
  const user = await requireDashboardUser();
  const dash = getUserDashboard(user.id);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Call history"
        icon={<HistoryIcon size={20} className="text-brand-300" />}
        description="Every call the switch saw on your extensions, newest first."
      />

      {dash.recent_calls.length === 0 ? (
        <Card>
          <EmptyState
            icon={<HistoryIcon size={26} />}
            title="No calls yet"
            description="Call history appears here once calls are made or received on your extensions."
          />
        </Card>
      ) : (
        <Card className="p-0">
          <div className="p-5">
            <CardHeader
              title="Recent calls"
              answers={`${dash.recent_calls.length} most recent`}
              icon={<PhoneIcon size={14} />}
            />
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-white/[0.06] text-xs text-white/40">
                    <th className="px-3 pb-3 font-medium">Direction</th>
                    <th className="px-3 pb-3 font-medium">Caller</th>
                    <th className="px-3 pb-3 font-medium">Number</th>
                    <th className="px-3 pb-3 font-medium">Duration</th>
                    <th className="px-3 pb-3 font-medium">Date</th>
                    <th className="px-3 pb-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {dash.recent_calls.map((call) => (
                    <tr key={call.id} className="transition-colors hover:bg-white/[0.02]">
                      <td className="px-3 py-3">
                        <Badge tone={call.direction === "inbound" ? "success" : "brand"}>
                          <PhoneIcon size={10} />
                          {call.direction}
                        </Badge>
                      </td>
                      <td className="px-3 py-3 font-medium text-white">
                        {call.caller_name ?? "—"}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-white/55">
                        {call.direction === "outbound" ? call.callee_number : call.caller_number}
                      </td>
                      <td className="px-3 py-3 text-white/40">
                        {fmtDuration(call.duration_seconds)}
                      </td>
                      <td className="px-3 py-3 text-xs text-white/35">
                        {fmtDate(call.created_at)}
                      </td>
                      <td className="px-3 py-3">
                        <Badge tone={call.status === "completed" ? "success" : "muted"}>
                          {call.status}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
