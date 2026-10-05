"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client-api";
import { AlertCircleIcon, CheckCircleIcon, RefreshIcon } from "@/components/icons";

interface Trunk {
  name: string;
  status: string;
  serverUri: string;
  failing: boolean;
}

interface Contact {
  extension: string;
  uri: string;
  status: string;
}

interface Health {
  ami_connected: boolean;
  trunks: Trunk[];
  failing_trunks: Trunk[];
  contacts: Contact[];
  registered_extensions: string[];
  unregistered_extensions: string[];
}

const POLL_MS = 15000;

/**
 * The live PBX picture, for the operator looking at a row that says "Offline".
 *
 * A row can only show what the portal cached about an extension; this panel asks
 * the PBX itself (see `/api/pbx/health`) and names the two faults no extension
 * row can: a trunk registration the PBX did not accept, and an extension no
 * phone has registered against at all. Admin-only, and rendered only for admins —
 * both facts are estate-wide.
 */
export default function PbxHealthPanel() {
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(false);
  // The refresh button bumps this, so the read is the effect's own async work
  // rather than a setState called straight from the effect body (which cascades
  // renders — the reason `PhoneSection` declares its poll inside the effect too).
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function sync() {
      try {
        const data = await api<Health>("/api/pbx/health");
        if (!cancelled) setHealth(data);
      } catch {
        // A refused or failed read is "cannot see the PBX", which the empty
        // state below says. No toast: this panel polls, and a toast per poll
        // would be noise for a fault that has no user action behind it.
        if (!cancelled) setHealth(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void sync();
    // Re-read when the extension list re-reads, so a registration the operator
    // just made shows here without waiting out the interval.
    const onEvent = () => void sync();
    window.addEventListener("pbx:extension-state-changed", onEvent);
    const timer = setInterval(sync, POLL_MS);
    return () => {
      cancelled = true;
      window.removeEventListener("pbx:extension-state-changed", onEvent);
      clearInterval(timer);
    };
  }, [refreshTick]);

  const failing = health?.failing_trunks ?? [];
  const contacts = health?.contacts ?? [];
  const unregistered = health?.unregistered_extensions ?? [];

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-[var(--foreground)]">PBX health</h2>
          <p className="text-sm text-[var(--text-secondary)]">
            What the PBX is doing now — read live, not from the dashboard&apos;s cache.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setLoading(true);
            setRefreshTick((tick) => tick + 1);
          }}
          disabled={loading}
          className="rounded-lg border border-white/[0.08] bg-white/[0.03] p-2 text-white/40 transition hover:text-[var(--foreground)] disabled:opacity-50"
          title="Re-read the PBX"
        >
          <RefreshIcon size={16} />
        </button>
      </div>

      {health === null ? (
        <p className="text-sm text-[var(--text-secondary)]">
          Cannot read the PBX — the portal&apos;s AMI link is down. Extension and trunk
          state below may be stale.
        </p>
      ) : !health.ami_connected ? (
        <div className="flex items-start gap-2 text-sm text-sun-400">
          <AlertCircleIcon size={16} className="mt-0.5 shrink-0" />
          <span>
            The portal cannot reach the PBX (AMI disconnected), so trunk and extension
            state is unknown rather than healthy.
          </span>
        </div>
      ) : (
        <div className="space-y-5">
          {/* Trunks: an outbound calling outage, which no extension row can show. */}
          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
              Trunk registrations
            </div>
            {health.trunks.length === 0 ? (
              <p className="text-sm text-[var(--text-secondary)]">No trunks configured.</p>
            ) : (
              <ul className="space-y-1.5">
                {health.trunks.map((trunk) => (
                  <li
                    key={trunk.name}
                    className="flex items-center gap-2 text-sm"
                    title={trunk.serverUri || undefined}
                  >
                    {trunk.failing ? (
                      <AlertCircleIcon size={15} className="shrink-0 text-rose-400" />
                    ) : (
                      <CheckCircleIcon size={15} className="shrink-0 text-mint-400" />
                    )}
                    <span className="font-mono text-[var(--foreground)]">{trunk.name}</span>
                    <span
                      className={trunk.failing ? "text-rose-400" : "text-[var(--text-secondary)]"}
                    >
                      {trunk.status || "unknown"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {failing.length > 0 && (
              <p className="mt-2 text-xs text-rose-400">
                {failing.length === 1
                  ? "One trunk is not registered — outbound calls through it will fail."
                  : `${failing.length} trunks are not registered — outbound calls through them will fail.`}
              </p>
            )}
          </div>

          {/* The live contacts: the device and address each extension is
              registered *from*. The positive half of the panel — the row that
              says "Offline" with no contact chip is one whose phone never
              registered; this names the phones that did, so an operator can
              tell a dead trunk or an unplugged phone from a config fault. */}
          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
              Registered contacts
            </div>
            {contacts.length === 0 ? (
              <p className="text-sm text-[var(--text-secondary)]">
                No phone is registered against any endpoint.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {contacts.map((contact, index) => (
                  <li
                    key={`${contact.extension}-${contact.uri}-${index}`}
                    className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm"
                    title={contact.uri || undefined}
                  >
                    <span className="font-mono text-[var(--foreground)]">
                      Ext {contact.extension}
                    </span>
                    <span
                      className={
                        contact.status.trim().toLowerCase() === "reachable"
                          ? "text-mint-400"
                          : "text-sun-400"
                      }
                    >
                      {contact.status || "unknown"}
                    </span>
                    {contact.uri && (
                      <span className="truncate font-mono text-xs text-[var(--text-secondary)]">
                        {contact.uri}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Extensions with no contact: the phone has never registered. */}
          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
              Extensions with no registration
            </div>
            {unregistered.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-mint-400">
                <CheckCircleIcon size={15} className="shrink-0" />
                Every extension has a registered contact.
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-1.5">
                {unregistered.map((ext) => (
                  <span
                    key={ext}
                    className="rounded-md border border-rose-500/20 bg-rose-500/10 px-2 py-0.5 font-mono text-xs text-rose-300"
                  >
                    {ext}
                  </span>
                ))}
                <span className="text-xs text-[var(--text-secondary)]">
                  — no softphone or device is registered against these.
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
