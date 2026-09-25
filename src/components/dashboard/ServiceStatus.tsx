"use client";

import { useCallback, useEffect, useState } from "react";
import {
  SERVICE_KEYS,
  SERVICE_META,
  statusLabel,
  statusTextClass,
  type HealthResponse,
} from "@/lib/health-services";
import { RefreshIcon, AlertCircleIcon } from "@/components/icons";
import { Badge, Card, CardHeader, EmptyState } from "@/components/ui";

/**
 * The estate's services, grouped by the product that owns them.
 *
 * It reads the same `/api/health` the Health page does, through the shared
 * `lib/health-services.ts` vocabulary, so the two cannot call a dependency
 * different things or paint the same state two colours. The difference is the
 * question: Health is "diagnose this dependency", this is "which product is
 * unwell".
 */
export function ServiceStatus() {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/health", { credentials: "include" });
      setData((await res.json()) as HealthResponse);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to read health data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const timer = setInterval(load, 15_000);
    return () => {
      window.clearTimeout(first);
      clearInterval(timer);
    };
  }, [load]);

  // Group by product, preserving the declaration order so the panel reads the
  // same on every render.
  const byProduct = SERVICE_KEYS.reduce<Record<string, typeof SERVICE_KEYS[number][]>>(
    (acc, key) => {
      const product = SERVICE_META[key].product;
      (acc[product] ??= []).push(key);
      return acc;
    },
    {},
  );

  return (
    <Card>
      <CardHeader
        title="Services"
        answers="Every dependency the estate runs on, grouped by the product that owns it."
        actions={
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-xs text-white/60 transition hover:bg-white/[0.06] hover:text-white"
          >
            <RefreshIcon size={14} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        }
      />

      {error ? (
        <div className="mb-3 flex items-center gap-2 rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          <AlertCircleIcon size={16} /> {error}
        </div>
      ) : null}

      {!data && loading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {SERVICE_KEYS.slice(0, 4).map((key) => (
            <div key={key} className="h-16 animate-pulse rounded-xl border border-white/[0.06] bg-white/[0.02]" />
          ))}
        </div>
      ) : !data ? (
        <EmptyState
          title="Health data unavailable"
          description="The health endpoint did not answer. This is the probe failing, not necessarily the services."
        />
      ) : (
        <div className="space-y-4">
          {Object.entries(byProduct).map(([product, keys]) => (
            <div key={product}>
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-white/30">
                {product}
              </div>
              <ul className="space-y-2">
                {keys.map((key) => {
                  const svc = data.services[key];
                  const meta = SERVICE_META[key];
                  return (
                    <li
                      key={key}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.06] px-4 py-2.5"
                    >
                      <div className="min-w-0">
                        <p className="text-sm text-white/80">{meta.label}</p>
                        <p className="truncate text-xs text-white/35">{svc.detail ?? meta.desc}</p>
                      </div>
                      <span className="flex shrink-0 items-center gap-3">
                        <span className="text-[11px] tabular-nums text-white/30">
                          {svc.latency_ms < 1000
                            ? `${svc.latency_ms}ms`
                            : `${(svc.latency_ms / 1000).toFixed(1)}s`}
                        </span>
                        <span className={statusTextClass(svc.status)}>
                          <Badge
                            tone={
                              svc.status === "ok"
                                ? "success"
                                : svc.status === "degraded"
                                  ? "warning"
                                  : "danger"
                            }
                          >
                            {statusLabel(svc.status)}
                          </Badge>
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
