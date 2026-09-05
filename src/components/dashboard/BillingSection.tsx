"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, fmtDate, planLabel, planPrice } from "@/lib/client-api";
import { CreditCardIcon, CheckCircleIcon, ArrowRightIcon } from "@/components/icons";
import { useToast } from "@/components/ToastProvider";
import type { User, BillingInvoice } from "@/lib/types";

interface Props {
  user: User;
  invoices: BillingInvoice[];
  magnateUrl: string;
}

export default function BillingSection({ user, invoices, magnateUrl }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);

  async function handlePlanAction() {
    if (magnateUrl) {
      // Magnate (RevenueOps) owns billing — send the user to the storefront.
      // The legacy /api/billing/checkout path is only a standalone fallback
      // (deprecated; requires STRIPE_SECRET_KEY).
      window.location.href = magnateUrl;
      return;
    }
    setLoading(true);
    try {
      const res = await api<{ url: string }>("/api/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ plan: user.plan === "consumer" ? "business" : user.plan }),
      });
      window.location.href = res.url;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to start checkout");
      setLoading(false);
    }
  }

  async function handleCancelPlan() {
    if (!confirm("Are you sure you want to cancel your plan? Service continues until end of billing period.")) return;
    if (magnateUrl) {
      // Cancellation runs through Magnate's Stripe customer portal (/manage).
      window.location.href = `${magnateUrl}/manage`;
      return;
    }
    setLoading(true);
    try {
      await api("/api/billing/cancel", { method: "POST" });
      toast.success("Plan cancelled. Access continues until end of billing period.");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to cancel");
    } finally { setLoading(false); }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">Billing</h1>
        <p className="mt-1 text-sm text-white/45">Manage your plan and view invoices.</p>
      </div>

      {/* Current plan */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Current Plan</h2>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="rounded-full bg-brand-500/15 px-3 py-1 text-sm font-semibold text-brand-300">{planLabel(user.plan)}</span>
            <span className="text-2xl font-bold text-white">{planPrice(user.plan)}</span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${user.plan_status === "active" ? "bg-mint-500/10 text-mint-400" : "bg-sun-400/10 text-sun-400"}`}>
              {user.plan_status === "active" ? "Active" : user.plan_status}
            </span>
            {user.plan === "consumer" ? (
              <button type="button" onClick={handlePlanAction} disabled={loading} className="btn-primary px-4 py-2 text-xs flex items-center gap-1.5">
                {loading ? "Loading..." : "Upgrade to Business"} <ArrowRightIcon size={14} />
              </button>
            ) : user.plan_status === "active" ? (
              <>
                <button type="button" onClick={handlePlanAction} disabled={loading} className="btn-ghost px-4 py-2 text-xs">{loading ? "Loading..." : "Manage plan"}</button>
                <button type="button" onClick={handleCancelPlan} disabled={loading} className="btn-ghost px-4 py-2 text-xs text-rose-400 hover:text-rose-300">Cancel</button>
              </>
            ) : null}
          </div>
        </div>
        <p className="mt-2 text-xs text-white/35">Since {fmtDate(user.created_at)}</p>
      </div>

      {/* AI Agents add-on (billed through Magnate) */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white">AI Agents add-on</h2>
            <p className="mt-1 max-w-xl text-sm text-white/45">
              Enable AI voice agents on Capstone: an agent seat, inbound DID
              routing, and Workflow Studio access. Billed monthly through
              Magnate alongside your Zeus plan.
            </p>
          </div>
          {magnateUrl ? (
            <a
              href={`${magnateUrl}/signup?plan=agents`}
              className="btn-primary inline-flex items-center gap-1.5 px-4 py-2 text-xs"
            >
              Add AI Agents <ArrowRightIcon size={14} />
            </a>
          ) : (
            <span className="text-xs text-white/35">Billing portal not configured</span>
          )}
        </div>
      </div>

      {/* Invoices */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Invoices</h2>
        {invoices.length === 0 ? (
          <div className="flex flex-col items-center rounded-2xl bg-white/[0.02] p-8 text-center">
            <CreditCardIcon size={32} className="text-white/10 mb-3" />
            <p className="text-sm text-white/45">No invoices yet.</p>
            <p className="mt-1 text-xs text-white/30">
              {magnateUrl ? (
                <>
                  Billing and invoices are managed by Magnate.{" "}
                  <a href={`${magnateUrl}/manage`} className="underline text-white/50 hover:text-white/80">Manage subscription</a>.
                </>
              ) : (
                "Invoices will appear here after your billing cycle starts."
              )}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {invoices.map(inv => (
              <div key={inv.id} className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                <div className="flex items-center gap-3">
                  <CheckCircleIcon size={16} className={inv.status === "paid" ? "text-mint-400" : "text-white/30"} />
                  <div>
                    <div className="text-sm font-medium text-white">{inv.invoice_number}</div>
                    <div className="text-xs text-white/35">{fmtDate(inv.period_start)} — {fmtDate(inv.period_end)}</div>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-sm font-semibold text-white">${inv.amount_due.toFixed(2)}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${inv.status === "paid" ? "bg-mint-500/10 text-mint-400" : "bg-sun-400/10 text-sun-400"}`}>{inv.status}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
