import { getCurrentUser } from "@/lib/auth";
import { getUserDashboard } from "@/lib/dashboard";
import { fmtDate, planLabel, planPrice } from "@/lib/client-api";
import { CreditCardIcon, CheckCircleIcon } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function BillingPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const dash = getUserDashboard(user.id);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">Billing</h1>
        <p className="mt-1 text-sm text-white/45">Manage your plan and view invoices.</p>
      </div>

      {/* Current plan */}
      <div className="card-surface rounded-2xl p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">Current Plan</h2>
            <div className="mt-2 flex items-center gap-3">
              <span className="rounded-full bg-brand-500/15 px-3 py-1 text-sm font-semibold text-brand-300">
                {planLabel(user.plan)}
              </span>
              <span className="text-2xl font-bold text-white">
                {planPrice(user.plan)}
              </span>
            </div>
            <p className="mt-1 text-xs text-white/35">
              {user.plan_status === "active" ? "Active" : user.plan_status} · Since {fmtDate(user.created_at)}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
              user.plan_status === "active" ? "bg-mint-500/10 text-mint-400" : "bg-sun-400/10 text-sun-400"
            }`}>
              {user.plan_status === "active" ? "Active" : user.plan_status}
            </span>
            <div className="flex gap-2">
              <button type="button" className="btn-ghost px-4 py-1.5 text-xs">
                {user.plan === "consumer" ? "Upgrade to Business" : "Manage plan"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Invoices */}
      <div className="card-surface rounded-2xl p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Invoices</h2>
        {dash.invoices.length === 0 ? (
          <div className="rounded-2xl bg-white/[0.02] p-8 text-center">
            <CreditCardIcon size={32} className="text-white/10 mx-auto mb-3" />
            <p className="text-sm text-white/45">No invoices yet.</p>
            <p className="mt-1 text-xs text-white/30">
              Invoices will appear here after your billing cycle starts.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {dash.invoices.map((inv) => (
              <div
                key={inv.id}
                className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <CheckCircleIcon size={16} className={inv.status === "paid" ? "text-mint-400" : "text-white/30"} />
                  <div>
                    <div className="text-sm font-medium text-white">
                      {inv.invoice_number}
                    </div>
                    <div className="text-xs text-white/35">
                      {fmtDate(inv.period_start)} — {fmtDate(inv.period_end)}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-sm font-semibold text-white">
                    ${inv.amount_due.toFixed(2)}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                    inv.status === "paid"
                      ? "bg-mint-500/10 text-mint-400"
                      : "bg-sun-400/10 text-sun-400"
                  }`}>
                    {inv.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
