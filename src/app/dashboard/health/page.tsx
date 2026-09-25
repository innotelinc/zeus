"use client";

import { useState, useEffect, useCallback } from "react";
import { RefreshIcon, CheckCircleIcon, AlertCircleIcon, HeartPulseIcon } from "@/components/icons";
import { PageHeader } from "@/components/ui";
import {
  SERVICE_KEYS,
  SERVICE_META,
  statusLabel,
  statusTextClass,
  type HealthResponse,
} from "@/lib/health-services";

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0 || d > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0 || d > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

function StatusDot({ status, pulse }: { status: string; pulse?: boolean }) {
  const colors: Record<string, string> = {
    ok: "bg-mint-400 shadow-[0_0_8px_rgba(34,197,94,0.4)]",
    degraded: "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.4)]",
    down: "bg-rose-400 shadow-[0_0_8px_rgba(244,63,94,0.4)]",
  };
  return (
    <span className="relative flex h-3 w-3">
      {pulse && (
        <span
          className={`absolute inset-0 h-3 w-3 animate-ping rounded-full opacity-60 ${colors[status]}`}
        />
      )}
      <span
        className={`relative h-3 w-3 rounded-full ${colors[status]}`}
      />
    </span>
  );
}

function LatencyBar({ ms, status }: { ms: number; status: string }) {
  // Cap visual bar at 2000ms
  const pct = Math.min(ms / 2000, 1);
  const barColor =
    status === "ok"
      ? ms < 200
        ? "bg-mint-500/60"
        : ms < 500
          ? "bg-mint-400/40"
          : "bg-amber-400/40"
      : "bg-rose-400/20";

  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className={`h-full rounded-full transition-all duration-700 ${barColor}`}
          style={{ width: `${Math.max(pct * 100, 2)}%` }}
        />
      </div>
      <span className="text-[11px] tabular-nums text-white/30">
        {ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}
      </span>
    </div>
  );
}

export default function HealthPage() {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastFetch, setLastFetch] = useState<number>(0);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health", { credentials: "include" });
      const json = (await res.json()) as HealthResponse;
      setData(json);
      setError(null);
      setLastFetch(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch health data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void fetchHealth(), 0);
    const interval = setInterval(fetchHealth, 15_000);
    return () => {
      window.clearTimeout(initial);
      clearInterval(interval);
    };
  }, [fetchHealth]);

  return (
    <div className="space-y-8">
      <PageHeader
        title="System health"
        icon={<HeartPulseIcon size={20} className="text-brand-300" />}
        description="Every dependency, probed, with what each failure would look like."
        actions={
          <button
            type="button"
            onClick={fetchHealth}
            className="flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-2.5 text-sm font-medium text-white/60 transition hover:bg-white/[0.06] hover:text-white active:scale-95"
          >
            <RefreshIcon size={16} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        }
      />

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-3 rounded-xl border border-rose-500/20 bg-rose-500/10 px-5 py-4 text-sm text-rose-300">
          <AlertCircleIcon size={18} />
          {error}
        </div>
      )}

      {/* Overall status banner */}
      {data && (
        <div
          className={`flex items-center gap-4 rounded-2xl border p-5 backdrop-blur-sm ${
            data.status === "ok"
              ? "border-mint-500/20 bg-mint-500/[0.06]"
              : data.status === "degraded"
                ? "border-amber-500/20 bg-amber-500/[0.06]"
                : "border-rose-500/20 bg-rose-500/[0.06]"
          }`}
        >
          <div
            className={`flex h-14 w-14 items-center justify-center rounded-full ${
              data.status === "ok"
                ? "bg-mint-500/15"
                : data.status === "degraded"
                  ? "bg-amber-500/15"
                  : "bg-rose-500/15"
            }`}
          >
            <StatusDot status={data.status} pulse />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <h2 className={`text-lg font-semibold ${statusTextClass(data.status)}`}>
                System {statusLabel(data.status)}
              </h2>
              <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-0.5 text-[11px] font-medium text-white/40">
                Uptime {formatUptime(data.uptime_seconds)}
              </span>
            </div>
            <p className="mt-0.5 text-sm text-white/35">
              {data.status === "ok"
                ? "All services are operational."
                : data.status === "degraded"
                  ? "One or more services are experiencing issues."
                  : "Multiple services are down — investigation needed."}
            </p>
          </div>
          <div className="text-right text-[11px] text-white/25">
            <div>Last checked</div>
            <div className="tabular-nums">
              {new Date(data.timestamp).toLocaleTimeString()}
            </div>
          </div>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !data && (
        <div className="grid gap-5 sm:grid-cols-2">
          {SERVICE_KEYS.map((key) => (
            <div
              key={key}
              className="animate-pulse rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6"
            >
              <div className="mb-4 h-4 w-24 rounded bg-white/[0.06]" />
              <div className="h-3 w-40 rounded bg-white/[0.04]" />
            </div>
          ))}
        </div>
      )}

      {/* Service cards */}
      {data && (
        <div className="grid gap-5 sm:grid-cols-2">
          {SERVICE_KEYS.map((key) => {
              const svc = data.services[key];
              const meta = SERVICE_META[key];
              const isOk = svc.status === "ok";
              const isDown = svc.status === "down";

              return (
                <div
                  key={key}
                  className={`group relative overflow-hidden rounded-2xl border transition-colors ${
                    isOk
                      ? "border-mint-500/10 bg-white/[0.02] hover:border-mint-500/20 hover:bg-white/[0.03]"
                      : "border-rose-500/15 bg-rose-500/[0.03] hover:border-rose-500/25"
                  }`}
                >
                  {/* Subtle gradient strip at top */}
                  <div
                    className={`absolute inset-x-0 top-0 h-px ${
                      isOk
                        ? "bg-gradient-to-r from-transparent via-mint-500/30 to-transparent"
                        : "bg-gradient-to-r from-transparent via-rose-500/30 to-transparent"
                    }`}
                  />

                  <div className="p-6">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <span className="text-2xl">{meta.icon}</span>
                        <div>
                          <h3 className="font-semibold text-white">{meta.label}</h3>
                          <p className="mt-0.5 text-xs text-white/35">{meta.desc}</p>
                        </div>
                      </div>
                      <StatusDot status={svc.status} pulse={isOk} />
                    </div>

                    <div className="mt-5 flex items-center justify-between">
                      <LatencyBar ms={svc.latency_ms} status={svc.status} />
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                          isOk
                            ? "border-mint-500/20 bg-mint-500/10 text-mint-400"
                            : isDown
                              ? "border-rose-500/20 bg-rose-500/10 text-rose-300"
                              : "border-amber-500/20 bg-amber-500/10 text-amber-400"
                        }`}
                      >
                        {isOk ? (
                          <CheckCircleIcon size={12} />
                        ) : (
                          <AlertCircleIcon size={12} />
                        )}
                        {statusLabel(svc.status)}
                      </span>
                    </div>

                    {/* Factual readout (what the engine loaded), neutral so a
                        healthy row is not painted as a failure for it. */}
                    {svc.detail && (
                      <div className="mt-4 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3.5 py-3">
                        <p className="text-xs leading-relaxed text-white/50">
                          {svc.detail}
                        </p>
                      </div>
                    )}

                    {/* Error detail */}
                    {svc.error && (
                      <div className="mt-4 rounded-lg border border-rose-500/15 bg-rose-500/5 px-3.5 py-3">
                        <p className="text-xs leading-relaxed text-rose-300/80 break-all">
                          {svc.error}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              );
            },
          )}
        </div>
      )}

      {/* Footer stats */}
      {data && (
        <div className="flex flex-wrap gap-4 text-[11px] text-white/20">
          <span>
            Polling every 15s · Last fetch:{" "}
            {lastFetch > 0
              ? new Date(lastFetch).toLocaleTimeString()
              : "—"}
          </span>
          <span>·</span>
          <span>
            OK:{" "}
            {
              Object.values(data.services).filter((s) => s.status === "ok")
                .length
            }{" "}
            / Degraded:{" "}
            {
              Object.values(data.services).filter(
                (s) => s.status === "degraded",
              ).length
            }{" "}
            / Down:{" "}
            {
              Object.values(data.services).filter((s) => s.status === "down")
                .length
            }
          </span>
        </div>
      )}
    </div>
  );
}
