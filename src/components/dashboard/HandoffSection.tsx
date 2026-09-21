"use client";

import { useCallback, useEffect, useState } from "react";
import { api, fmtDate, fmtDuration } from "@/lib/client-api";
import { ChevronDownIcon, FileTextIcon, RefreshIcon } from "@/components/icons";

interface HandoffRow {
  recordId: string;
  caller: string;
  startTime: string | null;
  durationSeconds: number | null;
  agent: string | null;
  avgTurnLatencyMs: number | null;
  totalTurns: number | null;
  outcome: string | null;
}

interface Turn {
  role?: string;
  content?: string | null;
  text?: string | null;
}

/**
 * Calls handed to Capstone, with the transcript on demand.
 *
 * The list is loaded in the browser rather than server-rendered: confirming a
 * hand-off needs the engine's full call records, and making the page wait on
 * that would stall the whole screen for a panel below the fold.
 */
export default function HandoffSection() {
  const [rows, setRows] = useState<HandoffRow[] | null>(null);
  const [state, setState] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[] | null>(null);
  const [destination, setDestination] = useState<string | null>(null);
  const [loadingTurns, setLoadingTurns] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = (await api("/api/voice/handoffs")) as {
        configured?: boolean;
        handoffs?: HandoffRow[];
        error?: string;
        ava_state?: string;
      };
      if (data.configured === false) {
        setRows([]);
        setNotice("The voice engine is not configured on this deployment.");
        return;
      }
      if (data.error) {
        setRows([]);
        setState(data.ava_state ?? "error");
        setNotice(`Could not read call records: ${data.error}`);
        return;
      }
      setNotice(null);
      setRows(data.handoffs ?? []);
    } catch (e) {
      setRows([]);
      setNotice(e instanceof Error ? e.message : "Could not read call records");
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    return () => clearTimeout(first);
  }, [load]);

  async function open(row: HandoffRow) {
    if (openId === row.recordId) {
      setOpenId(null);
      setTurns(null);
      return;
    }
    setOpenId(row.recordId);
    setTurns(null);
    setDestination(null);
    setLoadingTurns(true);
    try {
      const data = (await api(`/api/voice/handoffs/${encodeURIComponent(row.recordId)}`)) as {
        turns?: Turn[];
        transfer_destination?: string | null;
      };
      setTurns(data.turns ?? []);
      setDestination(data.transfer_destination ?? null);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not read that transcript");
    } finally {
      setLoadingTurns(false);
    }
  }

  return (
    <section className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-white/40">
          <FileTextIcon size={16} /> Handed-off calls
        </h2>
        <button
          type="button"
          onClick={load}
          className="inline-flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-xs text-white/60 transition hover:bg-white/[0.06] hover:text-white"
        >
          <RefreshIcon size={14} /> Refresh
        </button>
      </div>

      {notice && <p className="mt-3 text-sm text-amber-300">{notice}</p>}

      {rows === null && !notice && <p className="mt-3 text-sm text-white/40">Loading…</p>}

      {rows !== null && rows.length === 0 && !notice && (
        <p className="mt-3 text-sm text-white/40">
          No calls have been handed to Capstone yet.
        </p>
      )}

      {rows !== null && rows.length > 0 && (
        <ul className="mt-3 divide-y divide-white/[0.05]">
          {rows.map((row) => (
            <li key={row.recordId}>
              <button
                type="button"
                onClick={() => open(row)}
                className="flex w-full items-center justify-between gap-3 py-3 text-left transition hover:bg-white/[0.02]"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm text-white/80">{row.caller}</span>
                  <span className="block text-xs text-white/40">
                    {row.startTime ? fmtDate(row.startTime) : "unknown time"}
                    {row.agent ? ` · ${row.agent}` : ""}
                    {row.avgTurnLatencyMs != null
                      ? ` · ${Math.round(row.avgTurnLatencyMs)} ms/turn`
                      : ""}
                  </span>
                </span>
                <span className="flex items-center gap-3 text-xs text-white/40">
                  {row.durationSeconds != null ? fmtDuration(row.durationSeconds) : ""}
                  <ChevronDownIcon
                    size={14}
                    className={openId === row.recordId ? "rotate-180 transition" : "transition"}
                  />
                </span>
              </button>

              {openId === row.recordId && (
                <div className="mb-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                  {destination && (
                    <p className="mb-2 font-mono text-xs text-white/40">
                      handed off via {destination}
                    </p>
                  )}
                  {loadingTurns && <p className="text-sm text-white/40">Loading transcript…</p>}
                  {turns !== null && turns.length === 0 && (
                    <p className="text-sm text-white/40">No transcript was recorded.</p>
                  )}
                  {turns !== null &&
                    turns.map((turn, i) => (
                      <p key={i} className="mb-1.5 text-sm text-white/70">
                        <span className="mr-2 text-xs uppercase tracking-wide text-white/35">
                          {turn.role ?? "turn"}
                        </span>
                        {turn.content ?? turn.text ?? ""}
                      </p>
                    ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {state && state !== "ok" && (
        <p className="mt-3 text-xs text-white/40">Engine state: {state}</p>
      )}
    </section>
  );
}
