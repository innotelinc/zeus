"use client";

import { useState } from "react";
import { api } from "@/lib/client-api";
import type { PhoneNumber, FreePBXExtension } from "@/lib/types";
import { useToast } from "@/components/ToastProvider";
import { PlusIcon, RefreshIcon, CheckCircleIcon, SearchIcon, PhoneIcon, XIcon } from "@/components/icons";

interface Props {
  numbers: PhoneNumber[];
  extensions: FreePBXExtension[];
  plan: string;
}

export default function PhoneSection({ numbers: initialNumbers, extensions: initialExtensions, plan }: Props) {
  const { toast } = useToast();
  const [numbers, setNumbers] = useState(initialNumbers);
  const [extensions, setExtensions] = useState(initialExtensions);
  const [loading, setLoading] = useState(false);

  // DID search
  const [searchMode, setSearchMode] = useState(false);
  const [areaCode, setAreaCode] = useState("");
  const [searchResults, setSearchResults] = useState<Array<Record<string, string>>>([]);
  const [searching, setSearching] = useState(false);

  // Extension provision
  const [provisionMode, setProvisionMode] = useState(false);
  const [extForm, setExtForm] = useState({ id: "", name: "", email: "" });
  const [provisioning, setProvisioning] = useState(false);

  const maxNumbers = plan === "business" ? 5 : 1;

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

  async function provisionExtension() {
    if (!extForm.id || !extForm.name || !extForm.email) { toast.error("Please fill in all fields"); return; }
    setProvisioning(true);
    try {
      const res = await api<{ success: boolean; extensionId: string; secret: string }>("/api/phone/extensions", {
        method: "POST",
        body: JSON.stringify({ extensionId: extForm.id, name: extForm.name, email: extForm.email }),
      });
      if (res.success) {
        setExtensions(prev => [...prev, {
          id: res.extensionId, user_id: "", extension_id: res.extensionId,
          extension_name: extForm.name, extension_secret: res.secret,
          voicemail_enabled: 1, voicemail_pin: null, status: "active",
          device_state: "unknown", created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }]);
        setProvisionMode(false);
        setExtForm({ id: "", name: "", email: "" });
        toast.success("Extension provisioned.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Provisioning failed");
    } finally { setProvisioning(false); }
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">Phone Numbers</h1>
        <p className="mt-1 text-sm text-white/45">Manage your DIDs and FreePBX extensions.</p>
      </div>

      {/* Numbers card */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-semibold text-white">Your Numbers</h2>
            <p className="text-sm text-white/40">{numbers.length} of {maxNumbers} DIDs ({plan === "business" ? "Business" : "Consumer"} plan)</p>
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
          <div className="flex flex-col items-center rounded-2xl bg-white/[0.02] p-10 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-500/15 text-brand-300"><PhoneIcon size={26} /></div>
            <h3 className="mt-4 text-lg font-semibold text-white">No phone numbers yet</h3>
            <p className="mt-2 max-w-sm text-sm text-white/45">Order a phone number to start making and receiving calls.</p>
            {numbers.length < maxNumbers && (
              <button type="button" onClick={() => setSearchMode(true)} className="btn-primary mt-4 px-5 py-2 text-sm flex items-center gap-2">
                <PlusIcon size={14} /> Order your first number
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {numbers.map(n => (
              <div key={n.id} className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-5 py-4">
                <div className="flex items-center gap-3">
                  <CheckCircleIcon size={18} className="text-mint-400" />
                  <div>
                    <div className="font-mono text-lg font-semibold text-white">{n.did}</div>
                    <div className="mt-0.5 flex items-center gap-3 text-xs text-white/40">
                      {n.location && <span>{n.location}</span>}
                      {n.sms_enabled ? <span className="rounded-full bg-brand-500/10 px-2 py-0.5 text-brand-300">SMS</span> : null}
                      {n.fax_enabled ? <span className="rounded-full bg-sun-400/10 px-2 py-0.5 text-sun-400">Fax</span> : null}
                    </div>
                  </div>
                </div>
                <span className="rounded-full bg-mint-500/10 px-2.5 py-0.5 text-[11px] font-medium text-mint-400">Active</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Extensions card */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-semibold text-white">FreePBX Extensions</h2>
            <p className="text-sm text-white/40">SIP extensions for your devices</p>
          </div>
          <button type="button" onClick={() => setProvisionMode(true)} className="btn-primary px-4 py-2 text-sm flex items-center gap-2">
            <PlusIcon size={14} /> Add extension
          </button>
        </div>

        {extensions.length === 0 ? (
          <div className="rounded-2xl bg-white/[0.02] p-8 text-center">
            <p className="text-sm text-white/45">No extensions yet. Provision one to connect your SIP phone or softphone.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {extensions.map(ext => {
              const st = extState(ext.device_state);
              return (
                <div key={ext.id} className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-5 py-4">
                  <div className="flex items-center gap-3">
                    <div className="relative">
                      <CheckCircleIcon size={18} className={ext.device_state === "idle" ? "text-mint-400" : "text-white/25"} />
                      <span className={`absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-ink-950 ${st.dot}`} />
                    </div>
                    <div>
                      <div className="font-mono text-lg font-semibold text-white">Ext {ext.extension_id}</div>
                      <div className="text-xs text-white/40">{ext.extension_name}{ext.voicemail_enabled ? " · Voicemail enabled" : ""}</div>
                    </div>
                  </div>
                  <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${st.bg}`}>{st.label}</span>
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
