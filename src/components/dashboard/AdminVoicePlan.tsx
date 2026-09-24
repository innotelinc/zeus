"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client-api";
import { AlertCircleIcon, CheckCircleIcon, PhoneIcon, RefreshIcon } from "@/components/icons";

interface RoutingAccount {
  did: string;
  account?: string;
  agent?: string;
  capstone_addon: boolean;
  capstone_target?: string;
  provider?: string;
  audio_profile?: string;
}

interface RoutingResponse {
  generated_at: string;
  gate: { mode: string; reason: string };
  accounts: RoutingAccount[];
  capstone_not_enabled: Array<{ did: string; reason: string }>;
}

interface Props {
  /** Admin pages use the session; the PBX sync token never reaches the UI. */
  compact?: boolean;
}

export default function AdminVoicePlan({ compact = false }: Props) {
  const [plan, setPlan] = useState<RoutingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPlan(await api<RoutingResponse>("/api/admin/voice-routing"));
      setError(null);
    } catch (e) {
      setPlan(null);
      setError(e instanceof Error ? e.message : "Could not read the voice routing plan");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(initial);
  }, [load]);

  const entitled = plan?.accounts.filter((account) => account.capstone_addon).length ?? 0;
  const withTarget = plan?.accounts.filter((account) => account.capstone_target).length ?? 0;
  const blocked = plan?.capstone_not_enabled.length ?? 0;

  return (
    <section className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
            <PhoneIcon size={18} className="text-brand-300" /> Voice routing plan
          </h2>
          <p className="mt-1 text-sm text-white/45">
            The same plan the PBX renders: one account-safe answer per active DID.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs text-white/60 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-50"
        >
          <RefreshIcon size={14} className={loading ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {error ? (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-200">
          <AlertCircleIcon size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : loading && !plan ? (
        <p className="mt-4 text-sm text-white/40">Loading the current routing plan…</p>
      ) : plan ? (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-4">
            <Metric label="Active DIDs" value={plan.accounts.length} />
            <Metric label="Capstone enabled" value={entitled} />
            <Metric label="Interview targets" value={withTarget} />
            <Metric label="Needs attention" value={blocked} tone={blocked ? "warning" : "normal"} />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-white/35">
            <span>Gate: {plan.gate.mode} · {plan.gate.reason}</span>
            <span>Generated {new Date(plan.generated_at).toLocaleString()}</span>
          </div>

          {!compact && plan.accounts.length > 0 && (
            <div className="mt-5 overflow-x-auto rounded-xl border border-white/[0.06]">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-white/[0.06] bg-white/[0.02] text-xs text-white/35">
                    <th className="px-3 py-3 font-medium">DID</th>
                    <th className="px-3 py-3 font-medium">AVA agent</th>
                    <th className="px-3 py-3 font-medium">Interview target</th>
                    <th className="px-3 py-3 font-medium">Routing</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {plan.accounts.map((account) => {
                    const ready = account.capstone_addon && Boolean(account.capstone_target);
                    return (
                      <tr key={`${account.did}-${account.account ?? "unassigned"}`}>
                        <td className="px-3 py-3 font-mono text-xs text-white/70">{account.did}</td>
                        <td className="px-3 py-3 text-white/65">{account.agent ?? "default agent"}</td>
                        <td className="px-3 py-3 font-mono text-xs text-white/55">
                          {account.capstone_target ?? "—"}
                        </td>
                        <td className="px-3 py-3">
                          <span className={`inline-flex items-center gap-1.5 text-xs ${ready ? "text-mint-400" : account.capstone_addon ? "text-amber-300" : "text-white/35"}`}>
                            {ready ? <CheckCircleIcon size={13} /> : <AlertCircleIcon size={13} />}
                            {ready ? "Ready" : account.capstone_addon ? "No workflow" : "Capstone off"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

function Metric({ label, value, tone = "normal" }: { label: string; value: number; tone?: "normal" | "warning" }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
      <div className={`text-xl font-semibold ${tone === "warning" ? "text-amber-300" : "text-white"}`}>{value}</div>
      <div className="mt-0.5 text-[11px] text-white/35">{label}</div>
    </div>
  );
}
