"use client";

import { useState } from "react";
import { api } from "@/lib/client-api";
import type { PhoneNumber, FreePBXExtension } from "@/lib/types";
import { useToast } from "@/components/ToastProvider";
import {
  PlusIcon,
  RefreshIcon,
  CheckCircleIcon,
  SearchIcon,
  PhoneIcon,
} from "@/components/icons";

interface Props {
  numbers: PhoneNumber[];
  extensions: FreePBXExtension[];
  plan: string;
}

export default function PhoneSection({ numbers: initialNumbers, extensions: initialExtensions, plan }: Props) {
  const { toast } = useToast();
  const [numbers, setNumbers] = useState<PhoneNumber[]>(initialNumbers);
  const [extensions, setExtensions] = useState<FreePBXExtension[]>(initialExtensions);
  const [loading, setLoading] = useState(false);

  // DID search
  const [searchMode, setSearchMode] = useState(false);
  const [areaCode, setAreaCode] = useState("");
  const [searchResults, setSearchResults] = useState<Array<Record<string, string>>>([]);
  const [searching, setSearching] = useState(false);

  // Extension provisioning
  const [provisionMode, setProvisionMode] = useState(false);
  const [extId, setExtId] = useState("");
  const [extName, setExtName] = useState("");
  const [extEmail, setExtEmail] = useState("");
  const [provisioning, setProvisioning] = useState(false);

  async function searchDIDs() {
    setSearching(true);
    try {
      const res = await api<{ dids: Array<Record<string, string>> }>(
        "/api/phone/numbers",
        {
          method: "POST",
          body: JSON.stringify({
            action: "search",
            areacode: areaCode || undefined,
            quantity: 20,
          }),
        },
      );
      setSearchResults(res.dids ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to search numbers");
    } finally {
      setSearching(false);
    }
  }

  async function orderDID(did: string) {
    setLoading(true);
    try {
      const res = await api<{ number: PhoneNumber }>(
        "/api/phone/numbers",
        {
          method: "POST",
          body: JSON.stringify({ action: "order", did }),
        },
      );
      setNumbers((prev) => [res.number, ...prev]);
      setSearchMode(false);
      setSearchResults([]);
      toast.success(`Number ${did} ordered successfully.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to order number");
    } finally {
      setLoading(false);
    }
  }

  async function provisionExtension() {
    if (!extId || !extName || !extEmail) {
      toast.error("Please fill in all fields");
      return;
    }
    setProvisioning(true);
    try {
      const res = await api<{ success: boolean; extensionId: string; secret: string }>(
        "/api/phone/extensions",
        {
          method: "POST",
          body: JSON.stringify({ extensionId: extId, name: extName, email: extEmail }),
        },
      );
      if (res.success) {
        setExtensions((prev) => [
          ...prev,
          {
            id: res.extensionId,
            user_id: "",
            extension_id: res.extensionId,
            extension_name: extName,
            extension_secret: res.secret,
            voicemail_enabled: 1,
            voicemail_pin: null,
            status: "active",
            device_state: "unknown",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ]);
        setProvisionMode(false);
        setExtId("");
        setExtName("");
        setExtEmail("");
        toast.success("Extension provisioned successfully.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Provisioning failed");
    } finally {
      setProvisioning(false);
    }
  }

  async function refresh() {
    try {
      const res = await api<{ numbers: PhoneNumber[]; extensions: FreePBXExtension[] }>("/api/phone");
      setNumbers(res.numbers);
      setExtensions(res.extensions);
    } catch {
      /* ignore */
    }
  }

  const maxNumbers = plan === "business" ? 5 : 1;

  return (
    <div className="space-y-6">
      {/* Numbers card */}
      <div className="card-surface rounded-2xl p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-semibold text-white">Your Numbers</h2>
            <p className="text-sm text-white/40">
              {numbers.length} of {maxNumbers} DIDs ({plan === "business" ? "Business" : "Consumer"} plan)
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={refresh}
              className="rounded-lg border border-white/[0.08] bg-white/[0.03] p-2 text-white/40 transition hover:text-white"
              title="Refresh"
            >
              <RefreshIcon size={16} />
            </button>
            {numbers.length < maxNumbers && (
              <button
                type="button"
                onClick={() => setSearchMode(true)}
                className="btn-primary px-4 py-2 text-sm"
              >
                <PlusIcon size={14} />
                Add number
              </button>
            )}
          </div>
        </div>

        {numbers.length === 0 ? (
          <div className="flex flex-col items-center rounded-2xl bg-white/[0.02] p-10 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-500/15 text-brand-300">
              <PhoneIcon size={26} />
            </div>
            <h3 className="mt-4 text-lg font-semibold text-white">No phone numbers yet</h3>
            <p className="mt-2 max-w-sm text-sm text-white/45">
              Order a phone number to start making and receiving calls.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {numbers.map((n) => (
              <div
                key={n.id}
                className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-5 py-4"
              >
                <div className="flex items-center gap-3">
                  <CheckCircleIcon size={18} className="text-mint-400" />
                  <div>
                    <div className="font-mono text-lg font-semibold text-white">{n.did}</div>
                    <div className="mt-0.5 flex items-center gap-3 text-xs text-white/40">
                      {n.location && <span>{n.location}</span>}
                      {n.sms_enabled ? (
                        <span className="rounded-full bg-brand-500/10 px-2 py-0.5 text-brand-300">SMS</span>
                      ) : null}
                      {n.fax_enabled ? (
                        <span className="rounded-full bg-sun-400/10 px-2 py-0.5 text-sun-400">Fax</span>
                      ) : null}
                    </div>
                  </div>
                </div>
                <span className="rounded-full bg-mint-500/10 px-2.5 py-0.5 text-[11px] font-medium text-mint-400">
                  Active
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Extensions card */}
      <div className="card-surface rounded-2xl p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-semibold text-white">FreePBX Extensions</h2>
            <p className="text-sm text-white/40">SIP extensions for your devices</p>
          </div>
          <button
            type="button"
            onClick={() => setProvisionMode(true)}
            className="btn-primary px-4 py-2 text-sm"
          >
            <PlusIcon size={14} />
            Add extension
          </button>
        </div>

        {extensions.length === 0 ? (
          <div className="rounded-2xl bg-white/[0.02] p-8 text-center">
            <p className="text-sm text-white/45">
              No extensions yet. Provision one to connect your SIP phone or softphone.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {extensions.map((ext) => {
              const state = ext.device_state ?? "unknown";
              const stateColor = state === "idle"
                ? "bg-mint-400"
                : state === "in-call"
                  ? "bg-brand-400 animate-pulse"
                  : state === "ringing"
                    ? "bg-sun-400 animate-pulse"
                    : state === "busy"
                      ? "bg-rose-500"
                      : state === "on-hold"
                        ? "bg-sun-400"
                        : "bg-white/25";
              const stateLabel = state === "idle"
                ? "Idle"
                : state === "in-call"
                  ? "On Call"
                  : state === "ringing"
                    ? "Ringing"
                    : state === "busy"
                      ? "Busy"
                      : state === "on-hold"
                        ? "On Hold"
                        : state === "offline"
                          ? "Offline"
                          : "Unknown";
              const stateBg = state === "idle"
                ? "bg-mint-500/10 text-mint-400"
                : state === "in-call" || state === "ringing"
                  ? "bg-brand-500/10 text-brand-300"
                  : state === "busy" || state === "offline"
                    ? "bg-rose-500/10 text-rose-300"
                    : state === "on-hold"
                      ? "bg-sun-400/10 text-sun-400"
                      : "bg-white/[0.04] text-white/40";

              return (
                <div
                  key={ext.id}
                  className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-5 py-4"
                >
                  <div className="flex items-center gap-3">
                    <div className="relative">
                      <CheckCircleIcon size={18} className={state === "idle" ? "text-mint-400" : "text-white/25"} />
                      <span className={`absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-ink-950 ${stateColor}`} />
                    </div>
                    <div>
                      <div className="font-mono text-lg font-semibold text-white">
                        Ext {ext.extension_id}
                      </div>
                      <div className="text-xs text-white/40">
                        {ext.extension_name}
                        {ext.voicemail_enabled ? " · Voicemail enabled" : ""}
                      </div>
                    </div>
                  </div>
                  <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${stateBg}`}>
                    {stateLabel}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* DID search modal */}
      {searchMode && (
        <div className="card-surface rounded-2xl p-6 space-y-4 animate-slide-up">
          <h3 className="text-lg font-semibold text-white">Find a Phone Number</h3>
          <div className="flex gap-3">
            <input
              className="input-base max-w-[200px]"
              placeholder="Area code (e.g. 302)"
              value={areaCode}
              onChange={(e) => setAreaCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && searchDIDs()}
            />
            <button
              type="button"
              onClick={searchDIDs}
              disabled={searching}
              className="btn-primary px-5 py-2 text-sm"
            >
              {searching ? "Searching..." : "Search"}
              <SearchIcon size={14} />
            </button>
            <button
              type="button"
              onClick={() => {
                setSearchMode(false);
                setSearchResults([]);
              }}
              className="btn-ghost px-5 py-2 text-sm"
            >
              Cancel
            </button>
          </div>

          {searchResults.length > 0 && (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {searchResults.map((d) => (
                <div
                  key={d.did}
                  className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3"
                >
                  <div>
                    <div className="font-mono text-sm font-semibold text-white">{d.did}</div>
                    <div className="text-xs text-white/40">
                      {d.ratecenter}, {d.province}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => orderDID(d.did)}
                    disabled={loading}
                    className="btn-primary px-4 py-1.5 text-xs"
                  >
                    {loading ? "..." : "Order"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Extension provision form */}
      {provisionMode && (
        <div className="card-surface rounded-2xl p-6 space-y-4 animate-slide-up">
          <h3 className="text-lg font-semibold text-white">New Extension</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="space-y-1.5">
              <span className="input-label">Extension #</span>
              <input
                className="input-base"
                placeholder="1001"
                value={extId}
                onChange={(e) => setExtId(e.target.value)}
              />
            </label>
            <label className="space-y-1.5">
              <span className="input-label">Display Name</span>
              <input
                className="input-base"
                placeholder="John Doe"
                value={extName}
                onChange={(e) => setExtName(e.target.value)}
              />
            </label>
            <label className="space-y-1.5">
              <span className="input-label">Email</span>
              <input
                className="input-base"
                type="email"
                placeholder="john@company.com"
                value={extEmail}
                onChange={(e) => setExtEmail(e.target.value)}
              />
            </label>
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={provisionExtension}
              disabled={provisioning}
              className="btn-primary px-6 py-2.5 text-sm"
            >
              {provisioning ? "Provisioning..." : "Provision"}
            </button>
            <button
              type="button"
              onClick={() => setProvisionMode(false)}
              className="btn-ghost px-6 py-2.5 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
