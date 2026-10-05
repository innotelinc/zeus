"use client";

import { useState, useEffect, useRef } from "react";
import { api, apiErrorMessage } from "@/lib/client-api";
import type { PhoneNumber, FreePBXExtension } from "@/lib/types";
import { useToast } from "@/components/ToastProvider";
import { PlusIcon, RefreshIcon, CheckCircleIcon, SearchIcon, PhoneIcon, XIcon, TrashIcon, AlertCircleIcon } from "@/components/icons";
import { EmptyState, PageHeader } from "@/components/ui";
import PbxHealthPanel from "@/components/dashboard/PbxHealthPanel";
import { mediaAddressLabel, readinessLabel } from "@/lib/extension-readiness";

interface Props {
  numbers: PhoneNumber[];
  extensions: FreePBXExtension[];
  plan: string;
  /** Estate admins may reload/restart the PBX; a reload is PBX-wide, not per-account. */
  isAdmin?: boolean;
}

const POLL_MS = 5000;

export default function PhoneSection({ numbers: initialNumbers, extensions: initialExtensions, plan, isAdmin = false }: Props) {
  const { toast } = useToast();
  const [numbers, setNumbers] = useState(initialNumbers);
  const [extensions, setExtensions] = useState(initialExtensions);
  const [loading, setLoading] = useState(false);
  const [releasing, setReleasing] = useState<string | null>(null);
  const [confirmRelease, setConfirmRelease] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // DID search
  const [searchMode, setSearchMode] = useState(false);
  const [areaCode, setAreaCode] = useState("");
  const [searchResults, setSearchResults] = useState<Array<Record<string, string>>>([]);
  const [searching, setSearching] = useState(false);

  // Extension provision
  const [provisionMode, setProvisionMode] = useState(false);
  const [extForm, setExtForm] = useState({ id: "", name: "", email: "" });
  const [provisioning, setProvisioning] = useState(false);
  const [deletingExt, setDeletingExt] = useState<string | null>(null);
  const [confirmDeleteExt, setConfirmDeleteExt] = useState<string | null>(null);
  const [repairing, setRepairing] = useState<string | null>(null);
  // A PBX-wide action, in flight. Named by mode so the button being pressed is
  // the one that reads as busy.
  const [pbxBusy, setPbxBusy] = useState<"reload" | "restart" | null>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  // The extensions the PBX reports *no* contact for — a live read, not the
  // cached `device_state`. Empty and `contactsKnown: false` when the PBX could
  // not be asked: "unknown" must not be drawn as "no phone registered".
  const [noContact, setNoContact] = useState<string[]>([]);
  const [contactsKnown, setContactsKnown] = useState(false);

  const maxNumbers = plan === "business" ? 5 : 1;

  // ── Live device-state polling ────────────────────────────
  // Polls the AMI status endpoint every 5s and syncs
  // extension device states so the dashboard updates when a
  // softphone connects or disconnects.
  // Also listens for immediate sync events from SoftphoneSection.
  useEffect(() => {
    async function syncStates() {
      try {
        const data = await api<{
          extensions: Array<{ extension_id: string; device_state: string }>;
          contacts_known?: boolean;
          unregistered?: string[];
        }>("/api/ami/status?contacts=1");
        if (data.extensions) {
          setExtensions((prev) =>
            prev.map((ext) => {
              const live = data.extensions.find(
                (e) => e.extension_id === ext.extension_id,
              );
              return live && live.device_state !== ext.device_state
                ? { ...ext, device_state: live.device_state }
                : ext;
            }),
          );
        }
        // The live half of the row's state: which extensions have no contact
        // on the PBX at all. Cleared when the PBX could not be asked, so a
        // dropped AMI link leaves the last cache rather than a false "no
        // contact" on every row.
        const known = data.contacts_known === true;
        setContactsKnown(known);
        const next = known ? [...(data.unregistered ?? [])].sort() : [];
        setNoContact((prev) =>
          prev.length === next.length && prev.every((id, i) => id === next[i])
            ? prev
            : next,
        );
      } catch {
        /* polling is best-effort */
      }
    }

    // Immediate sync when softphone connects/disconnects
    const handleEvent = () => syncStates();
    window.addEventListener("pbx:extension-state-changed", handleEvent);

    // Fire immediately on mount so already-registered extensions show correct state
    syncStates();
    pollRef.current = setInterval(syncStates, POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      window.removeEventListener("pbx:extension-state-changed", handleEvent);
    };
  }, []);

  // ── Actions ─────────────────────────────────────────────

  async function searchDIDs() {
    setSearching(true);
    try {
      const res = await api<{ dids: Array<Record<string, string>> }>("/api/phone/numbers", {
        method: "POST",
        body: JSON.stringify({ action: "search", areacode: areaCode || undefined, quantity: 20 }),
      });
      setSearchResults(res.dids ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Search failed");
    } finally { setSearching(false); }
  }

  async function orderDID(did: string) {
    setLoading(true);
    try {
      const res = await api<{ number: PhoneNumber }>("/api/phone/numbers", {
        method: "POST",
        body: JSON.stringify({ action: "order", did }),
      });
      setNumbers(prev => [res.number, ...prev]);
      setSearchMode(false); setSearchResults([]);
      toast.success(`Number ${did} ordered successfully.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Order failed");
    } finally { setLoading(false); }
  }

  async function releaseNumber(did: string) {
    setReleasing(did);
    try {
      await api(`/api/phone/numbers?did=${encodeURIComponent(did)}`, { method: "DELETE" });
      setNumbers(prev => prev.filter(n => n.did !== did));
      setConfirmRelease(null);
      toast.success(`Number ${did} released.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Release failed");
    } finally { setReleasing(null); }
  }

  async function provisionExtension() {
    if (!extForm.id || !extForm.name || !extForm.email) { toast.error("Please fill in all fields"); return; }
    setProvisioning(true);
    try {
      const res = await api<{ success: boolean; extensionId: string; secret: string }>("/api/phone/extensions", {
        method: "POST",
        body: JSON.stringify({ extensionId: extForm.id, name: extForm.name, email: extForm.email }),
      });
      if (res.success) {
        setProvisionMode(false);
        setExtForm({ id: "", name: "", email: "" });
        // Re-read rather than appending a row built here: the new extension's
        // softphone readiness is a judgement about the PBX's config directory,
        // and "ready" is not something this side can assume.
        await refresh();
        toast.success("Extension provisioned.");
      }
    } catch (e) {
      // The preflight's refusals are structured (`reason` + `repair`): a number
      // that already exists, or one with leftover state. Surfacing the reason is
      // the whole point — the old path showed a raw collision and nothing else.
      toast.error(apiErrorMessage(e, "Provisioning failed"));
    } finally { setProvisioning(false); }
  }

  /**
   * Adopt the secret the PBX renders, and rewrite the WebRTC endpoint with it.
   *
   * The two data causes of "Offline" in one action: a row with no secret, and a
   * row whose secret FreePBX never rendered. The include is not written — that
   * is the endpoint-ownership decision, and the response names the line to add.
   */
  async function repairExtension(ext: FreePBXExtension) {
    setRepairing(ext.id);
    try {
      const res = await api<{
        adopted_pbx_secret: boolean;
        softphone: FreePBXExtension["softphone"];
      }>("/api/phone/extensions/repair", {
        method: "POST",
        body: JSON.stringify({ id: ext.id }),
      });
      setExtensions(prev =>
        prev.map(e => (e.id === ext.id ? { ...e, softphone: res.softphone } : e)),
      );
      toast.success(
        res.adopted_pbx_secret
          ? `Adopted the secret the PBX renders for Ext ${ext.extension_id}.`
          : `Rewrote the softphone endpoint for Ext ${ext.extension_id}.`,
      );
      if (res.softphone && res.softphone.state === "not-loaded") {
        toast.info(
          `Still no WebRTC settings — add "${res.softphone.requiredSection}" to ${res.softphone.file}.`,
        );
      }
    } catch (e) {
      // The refusal carries `reason` + `repair`; surfacing them is the point.
      toast.error(apiErrorMessage(e, "Repair failed"));
    } finally {
      setRepairing(null);
    }
  }

  /**
   * The PBX-side remedy for an extension that will not register.
   *
   * Repair fixes a row; this fixes the box. `reload` re-reads the PJSIP
   * endpoints (live calls survive), `restart` is the entrypoint's own
   * `core restart now` and drops every call — which is why it is confirmed.
   */
  async function reloadOrRestartPbx(mode: "reload" | "restart") {
    setPbxBusy(mode);
    try {
      const res = await api<{ success: boolean; mode: string; message?: string }>(
        "/api/pbx/restart",
        { method: "POST", body: JSON.stringify({ mode }) },
      );
      toast.success(res.message ?? (mode === "reload" ? "PJSIP reloaded." : "PBX restarting."));
      setConfirmRestart(false);
      // Device states will flip as Asterisk comes back; re-read shortly so the
      // list is not left showing the pre-restart state.
      setTimeout(refresh, mode === "restart" ? 12_000 : 1_500);
    } catch (e) {
      toast.error(apiErrorMessage(e, "PBX action failed"));
    } finally {
      setPbxBusy(null);
    }
  }

  async function deleteExtension(extDbId: string, extNumber: string) {
    setDeletingExt(extDbId);
    try {
      await api(`/api/phone/extensions?id=${encodeURIComponent(extDbId)}`, { method: "DELETE" });
      setExtensions(prev => prev.filter(e => e.id !== extDbId));
      setConfirmDeleteExt(null);
      toast.success(`Extension ${extNumber} removed.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    } finally { setDeletingExt(null); }
  }

  async function refresh() {
    try {
      const res = await api<{ numbers: PhoneNumber[]; extensions: FreePBXExtension[] }>("/api/phone");
      setNumbers(res.numbers);
      setExtensions(res.extensions);
    } catch { /* ignore */ }
  }

  const extState = (s: string) => {
    const map: Record<string, { label: string; dot: string; bg: string }> = {
      idle: { label: "Idle", dot: "bg-mint-400", bg: "bg-mint-500/10 text-mint-400" },
      "in-call": { label: "On Call", dot: "bg-brand-400 animate-pulse", bg: "bg-brand-500/10 text-brand-300" },
      ringing: { label: "Ringing", dot: "bg-sun-400 animate-pulse", bg: "bg-brand-500/10 text-brand-300" },
      busy: { label: "Busy", dot: "bg-rose-500", bg: "bg-rose-500/10 text-rose-300" },
      "on-hold": { label: "On Hold", dot: "bg-sun-400", bg: "bg-sun-400/10 text-sun-400" },
      offline: { label: "Offline", dot: "bg-white/25", bg: "bg-rose-500/10 text-rose-300" },
      unknown: { label: "Unknown", dot: "bg-white/25", bg: "bg-white/[0.04] text-white/40" },
    };
    return map[s] ?? map.unknown;
  };

  function numberStatus(n: PhoneNumber) {
    if (n.status === "active") {
      const features: string[] = [];
      if (n.sms_enabled) features.push("SMS");
      if (n.fax_enabled) features.push("Fax");
      return { label: "Active", color: "bg-mint-500/10 text-mint-400 border-mint-500/20", features };
    }
    if (n.status === "pending") return { label: "Provisioning", color: "bg-sun-400/10 text-sun-400 border-sun-400/20", features: [] };
    if (n.status === "failed") return { label: "Failed", color: "bg-rose-500/10 text-rose-300 border-rose-500/20", features: [] };
    return { label: n.status, color: "bg-white/[0.04] text-white/40 border-white/[0.08]", features: [] };
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Phone Numbers"
        icon={<PhoneIcon size={20} className="text-brand-300" />}
        description="Manage your DIDs and FreePBX extensions."
      />

      {/* Release confirm */}
      {confirmRelease && (
        <div className="rounded-2xl border border-rose-500/20 bg-rose-500/5 p-6 text-center">
          <div className="flex justify-center mb-3"><AlertCircleIcon size={28} className="text-rose-400" /></div>
          <p className="font-medium text-white">Release {confirmRelease}?</p>
          <p className="mt-1 text-sm text-white/40">This number will be removed from your account and returned to the pool. This cannot be undone.</p>
          <div className="mt-4 flex justify-center gap-3">
            <button type="button" onClick={() => releaseNumber(confirmRelease)} disabled={releasing === confirmRelease}
              className="rounded-xl bg-rose-500 px-6 py-2 text-sm font-medium text-white transition hover:bg-rose-600 disabled:opacity-50">
              {releasing === confirmRelease ? "Releasing..." : "Yes, release it"}
            </button>
            <button type="button" onClick={() => setConfirmRelease(null)} className="btn-ghost px-6 py-2 text-sm">Cancel</button>
          </div>
        </div>
      )}

      {/* Restart PBX confirm */}
      {confirmRestart && (
        <div className="rounded-2xl border border-rose-500/20 bg-rose-500/5 p-6 text-center">
          <div className="flex justify-center mb-3"><AlertCircleIcon size={28} className="text-rose-400" /></div>
          <p className="font-medium text-white">Restart the PBX?</p>
          <p className="mt-1 text-sm text-white/40">
            Asterisk restarts now. Every active call drops and extensions cannot register for a few seconds.
            Use <span className="font-medium text-white/60">Reload PJSIP</span> if only the softphone endpoints need re-reading.
          </p>
          <div className="mt-4 flex justify-center gap-3">
            <button type="button" onClick={() => void reloadOrRestartPbx("restart")} disabled={pbxBusy === "restart"}
              className="rounded-xl bg-rose-500 px-6 py-2 text-sm font-medium text-white transition hover:bg-rose-600 disabled:opacity-50">
              {pbxBusy === "restart" ? "Restarting…" : "Yes, restart the PBX"}
            </button>
            <button type="button" onClick={() => setConfirmRestart(false)} className="btn-ghost px-6 py-2 text-sm">Cancel</button>
          </div>
        </div>
      )}

      {/* Delete extension confirm */}
      {confirmDeleteExt && (() => {
        const ext = extensions.find(e => e.id === confirmDeleteExt);
        return (
          <div className="rounded-2xl border border-rose-500/20 bg-rose-500/5 p-6 text-center">
            <div className="flex justify-center mb-3"><AlertCircleIcon size={28} className="text-rose-400" /></div>
            <p className="font-medium text-white">Remove Extension {ext?.extension_id ?? "?"}?</p>
            <p className="mt-1 text-sm text-white/40">This will delete the extension from FreePBX, remove voicemail, and clean up all associated config.</p>
            <div className="mt-4 flex justify-center gap-3">
              <button type="button" onClick={() => deleteExtension(confirmDeleteExt, ext?.extension_id ?? "")} disabled={deletingExt === confirmDeleteExt}
                className="rounded-xl bg-rose-500 px-6 py-2 text-sm font-medium text-white transition hover:bg-rose-600 disabled:opacity-50">
                {deletingExt === confirmDeleteExt ? "Removing..." : "Yes, remove it"}
              </button>
              <button type="button" onClick={() => setConfirmDeleteExt(null)} className="btn-ghost px-6 py-2 text-sm">Cancel</button>
            </div>
          </div>
        );
      })()}

      {/* Numbers card */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-semibold text-white">Your Numbers</h2>
            <p className="text-sm text-white/40">{numbers.length} of {maxNumbers} numbers</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={refresh} className="rounded-lg border border-white/[0.08] bg-white/[0.03] p-2 text-white/40 transition hover:text-white" title="Refresh">
              <RefreshIcon size={16} />
            </button>
            {numbers.length < maxNumbers && (
              <button type="button" onClick={() => setSearchMode(true)} className="btn-primary px-4 py-2 text-sm flex items-center gap-2">
                <PlusIcon size={14} /> Add number
              </button>
            )}
          </div>
        </div>

        {numbers.length === 0 ? (
          <EmptyState
            icon={<PhoneIcon size={26} />}
            title="No phone numbers yet"
            description="Order a phone number to start making and receiving calls."
            action={
              numbers.length < maxNumbers ? (
                <button type="button" onClick={() => setSearchMode(true)} className="btn-primary flex items-center gap-2 px-5 py-2 text-sm">
                  <PlusIcon size={14} /> Order your first number
                </button>
              ) : undefined
            }
          />
        ) : (
          <div className="space-y-3">
            {numbers.map(n => {
              const st = numberStatus(n);
              return (
                <div key={n.id} className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-5 py-4 group">
                  <div className="flex items-center gap-3 min-w-0">
                    <CheckCircleIcon size={18} className={n.status === "active" ? "text-mint-400 shrink-0" : "text-white/25 shrink-0"} />
                    <div className="min-w-0">
                      <div className="font-mono text-lg font-semibold text-white truncate">{n.did}</div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-white/40 flex-wrap">
                        {n.location && <span>{n.location}</span>}
                        {st.features.map(f => (
                          <span key={f} className={`rounded-full px-2 py-0.5 ${f === "SMS" ? "bg-brand-500/10 text-brand-300" : "bg-sun-400/10 text-sun-400"}`}>{f}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${st.color}`}>{st.label}</span>
                    <button type="button" onClick={() => setConfirmRelease(n.did)}
                      className="rounded-lg p-1.5 text-white/20 transition hover:text-rose-400 hover:bg-rose-500/10 opacity-0 group-hover:opacity-100"
                      title={`Release ${n.did}`}>
                      <TrashIcon size={15} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* The live PBX picture, before the cards it explains: an operator
          looking at an extension that will not register needs the trunk and
          contact state, which no extension row can show. Admin-only, like the
          reload/restart controls in the card below. */}
      {isAdmin && <PbxHealthPanel />}

      {/* Extensions card */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-semibold text-white">FreePBX Extensions</h2>
            <p className="text-sm text-white/40">SIP extensions for your devices</p>
          </div>
          <div className="flex items-center gap-2">
            {/* Shown only to admins, and only here: this page is where an
                extension that will not register is named, so it is where the
                remedy belongs. A tenant cannot see it — a reload is
                estate-wide. */}
            {isAdmin && (
              <>
                <button
                  type="button"
                  onClick={() => void reloadOrRestartPbx("reload")}
                  disabled={pbxBusy !== null}
                  className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-white/[0.06] hover:text-[var(--foreground)] disabled:opacity-50"
                  title="Re-read the PJSIP endpoints from disk. Live calls survive."
                >
                  {pbxBusy === "reload" ? "Reloading…" : "Reload PJSIP"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmRestart(true)}
                  disabled={pbxBusy !== null}
                  className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-rose-500/10 hover:text-rose-400 disabled:opacity-50"
                  title="Restart Asterisk. Every call drops and the PBX is unreachable for a few seconds."
                >
                  {pbxBusy === "restart" ? "Restarting…" : "Restart PBX"}
                </button>
              </>
            )}
            <button type="button" onClick={() => setProvisionMode(true)} className="btn-primary px-4 py-2 text-sm flex items-center gap-2">
              <PlusIcon size={14} /> Add extension
            </button>
          </div>
        </div>

        {extensions.length === 0 ? (
          <EmptyState
            title="No extensions yet"
            description="Provision one to connect your SIP phone or softphone."
            action={
              <button type="button" onClick={() => setProvisionMode(true)} className="btn-primary flex items-center gap-2 px-5 py-2 text-sm">
                <PlusIcon size={14} /> Add your first extension
              </button>
            }
          />
        ) : (
          <div className="space-y-3">
            {extensions.map(ext => {
              const st = extState(ext.device_state);
              return (
                <div key={ext.id} className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-5 py-4 group">
                  <div className="flex items-center gap-3">
                    <div className="relative">
                      <CheckCircleIcon size={18} className={ext.device_state === "idle" ? "text-mint-400" : "text-white/25"} />
                      <span className={`absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--background)] ${st.dot}`} />
                    </div>
                    <div>
                      {/* Theme tokens, not `text-white`: this number is the one
                          thing on the card the operator must read. */}
                      <div className="font-mono text-lg font-semibold text-[var(--foreground)]">Ext {ext.extension_id}</div>
                      <div className="text-xs text-[var(--text-secondary)]">{ext.extension_name}{ext.voicemail_enabled ? " · Voicemail enabled" : ""}</div>
                      {/* "Offline" alone is one word for three different
                          faults; this names the one to fix first. The full
                          sentence is the tooltip, because it carries the file
                          and line the operator has to touch. */}
                      {ext.softphone && (
                        <div
                          className={`mt-1 flex items-center gap-1.5 text-xs ${
                            ext.softphone.state === "ready" ? "text-mint-400" : "text-sun-400"
                          }`}
                          title={ext.softphone.summary}
                        >
                          {ext.softphone.state === "ready" ? (
                            <CheckCircleIcon size={12} />
                          ) : (
                            <AlertCircleIcon size={12} />
                          )}
                          {readinessLabel(ext.softphone)}
                        </div>
                      )}
                      {/* The address the phone is told to send its media to.
                          Silent when there is none: a phone with no media
                          address is handed the PBX's own (unreachable)
                          address and loses its audio one way, which is the
                          fault the readiness summary above names. */}
                      {ext.softphone && mediaAddressLabel(ext.softphone) && (
                        <div
                          className="mt-0.5 text-xs text-[var(--text-secondary)]"
                          title="The address this phone is told to send its media to. If it is not one the phone can reach, its voice and DTMF are lost one way."
                        >
                          {mediaAddressLabel(ext.softphone)}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {/* The cached row says "Offline"; this says *why* one of
                        those is different — the PBX holds no contact for it, so
                        nothing has ever registered. Live, so it is absent when
                        the PBX could not be asked rather than guessed at. */}
                    {contactsKnown && noContact.includes(ext.extension_id) && (
                      <span
                        className="rounded-full border border-rose-500/20 bg-rose-500/10 px-2.5 py-0.5 text-[11px] font-medium text-rose-300"
                        title="The PBX reports no contact for this extension — no phone or softphone is registered against it."
                      >
                        No contact
                      </span>
                    )}
                    <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${st.bg}`}>{st.label}</span>
                    {ext.softphone && ext.softphone.state !== "ready" && (
                      <button type="button" onClick={() => void repairExtension(ext)}
                        disabled={repairing === ext.id}
                        className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-sun-400 transition hover:bg-sun-400/10 disabled:opacity-50"
                        title="Adopt the secret the PBX renders for this extension and rewrite its WebRTC endpoint">
                        {repairing === ext.id ? "Repairing…" : "Repair"}
                      </button>
                    )}
                    <button type="button" onClick={() => setConfirmDeleteExt(ext.id)}
                      className="rounded-lg p-1.5 text-white/20 transition hover:text-rose-400 hover:bg-rose-500/10 opacity-0 group-hover:opacity-100"
                      title={`Remove Ext ${ext.extension_id}`}>
                      <TrashIcon size={15} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* DID search modal */}
      {searchMode && (
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-white">Find a Phone Number</h3>
            <button type="button" onClick={() => { setSearchMode(false); setSearchResults([]); }} className="rounded-lg p-1.5 text-white/30 hover:text-white/60"><XIcon size={18} /></button>
          </div>
          <div className="flex gap-3">
            <input className="w-full max-w-[200px] rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:border-brand-500/50 focus:outline-none"
              placeholder="Area code (e.g. 302)" value={areaCode} onChange={e => setAreaCode(e.target.value)} onKeyDown={e => e.key === "Enter" && searchDIDs()} />
            <button type="button" onClick={searchDIDs} disabled={searching} className="btn-primary px-5 py-2 text-sm flex items-center gap-2">
              {searching ? "Searching..." : "Search"} <SearchIcon size={14} />
            </button>
          </div>
          {searchResults.length > 0 && (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {searchResults.map(d => (
                <div key={d.did} className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                  <div>
                    <div className="font-mono text-sm font-semibold text-white">{d.did}</div>
                    <div className="text-xs text-white/40">{d.ratecenter}, {d.province}</div>
                  </div>
                  <button type="button" onClick={() => orderDID(d.did)} disabled={loading} className="btn-primary px-4 py-1.5 text-xs">{loading ? "..." : "Order"}</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Extension provision form */}
      {provisionMode && (
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-white">New Extension</h3>
            <button type="button" onClick={() => setProvisionMode(false)} className="rounded-lg p-1.5 text-white/30 hover:text-white/60"><XIcon size={18} /></button>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-white/50">Extension #</span>
              <input className="w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:border-brand-500/50 focus:outline-none"
                placeholder="1001" value={extForm.id} onChange={e => setExtForm(p => ({ ...p, id: e.target.value }))} />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-white/50">Display Name</span>
              <input className="w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:border-brand-500/50 focus:outline-none"
                placeholder="John Doe" value={extForm.name} onChange={e => setExtForm(p => ({ ...p, name: e.target.value }))} />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-white/50">Email</span>
              <input className="w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:border-brand-500/50 focus:outline-none"
                type="email" placeholder="john@company.com" value={extForm.email} onChange={e => setExtForm(p => ({ ...p, email: e.target.value }))} />
            </label>
          </div>
          <div className="flex gap-3">
            <button type="button" onClick={provisionExtension} disabled={provisioning} className="btn-primary px-6 py-2.5 text-sm">{provisioning ? "Provisioning..." : "Provision"}</button>
            <button type="button" onClick={() => setProvisionMode(false)} className="btn-ghost px-6 py-2.5 text-sm">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
