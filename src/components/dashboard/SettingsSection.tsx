"use client";

import { useState, useEffect } from "react";
import { api } from "@/lib/client-api";
import { CheckCircleIcon } from "@/components/icons";
import { useToast } from "@/components/ToastProvider";
import type { User } from "@/lib/types";
import Link from "next/link";

interface Props {
  user: User;
}

const WSS_STORAGE_KEY = "wssUrl";

export default function SettingsSection({ user }: Props) {
  const { toast } = useToast();

  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [phone, setPhone] = useState(user.phone ?? "");
  const [country, setCountry] = useState(user.country);

  const [currentPwd, setCurrentPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");

  const [saving, setSaving] = useState(false);
  const [pwdSaving, setPwdSaving] = useState(false);

  const defaultWss = process.env.NEXT_PUBLIC_FREEPBX_WSS_URL ?? `wss://${typeof window !== "undefined" ? window.location.hostname : "localhost"}:8089/ws`;
  const [wssUrl, setWssUrl] = useState(defaultWss);
  const [wssSaved, setWssSaved] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(WSS_STORAGE_KEY);
    if (stored) setWssUrl(stored);
  }, []);

  function saveWssUrl() {
    const trimmed = wssUrl.trim();
    if (!trimmed.startsWith("wss://") && !trimmed.startsWith("ws://")) {
      toast.error("URL must start with wss:// or ws://");
      return;
    }
    localStorage.setItem(WSS_STORAGE_KEY, trimmed);
    setWssSaved(true);
    toast.success("WebSocket URL saved. Reconnect the softphone to apply.");
    setTimeout(() => setWssSaved(false), 3000);
  }

  function resetWssUrl() {
    localStorage.removeItem(WSS_STORAGE_KEY);
    setWssUrl(defaultWss);
    setWssSaved(false);
    toast.success("Reset to default. Reconnect the softphone to apply.");
  }

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api("/api/settings/profile", { method: "PATCH", body: JSON.stringify({ name, email, phone: phone || null, country }) });
      toast.success("Profile updated.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally { setSaving(false); }
  }

  async function updatePassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPwd !== confirmPwd) { toast.error("New passwords do not match."); return; }
    if (newPwd.length < 8) { toast.error("Password must be at least 8 characters."); return; }
    setPwdSaving(true);
    try {
      await api("/api/settings/password", { method: "POST", body: JSON.stringify({ currentPassword: currentPwd, newPassword: newPwd }) });
      setCurrentPwd(""); setNewPwd(""); setConfirmPwd("");
      toast.success("Password updated.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
    } finally { setPwdSaving(false); }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">Settings</h1>
        <p className="mt-1 text-sm text-white/45">Manage your account settings.</p>
      </div>

      {/* Profile */}
      <form onSubmit={saveProfile} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6 space-y-4">
        <h2 className="text-lg font-semibold text-white">Profile</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-white/50">Name</span>
            <input className="w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:border-brand-500/50 focus:outline-none"
              value={name} onChange={e => setName(e.target.value)} />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-white/50">Email</span>
            <input className="w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:border-brand-500/50 focus:outline-none"
              type="email" value={email} onChange={e => setEmail(e.target.value)} />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-white/50">Phone</span>
            <input className="w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:border-brand-500/50 focus:outline-none"
              type="tel" placeholder="+1 555 123 4567" value={phone} onChange={e => setPhone(e.target.value)} />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-white/50">Country</span>
            <input className="w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:border-brand-500/50 focus:outline-none"
              value={country} onChange={e => setCountry(e.target.value)} />
          </label>
        </div>
        <button type="submit" disabled={saving} className="btn-primary px-6 py-2.5 text-sm">{saving ? "Saving..." : "Save changes"}</button>
      </form>

      {/* Password */}
      <form onSubmit={updatePassword} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6 space-y-4">
        <h2 className="text-lg font-semibold text-white">Change Password</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-white/50">Current password</span>
            <input className="w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:border-brand-500/50 focus:outline-none"
              type="password" value={currentPwd} onChange={e => setCurrentPwd(e.target.value)} />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-white/50">New password</span>
            <input className="w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:border-brand-500/50 focus:outline-none"
              type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)} />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-white/50">Confirm new password</span>
            <input className="w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:border-brand-500/50 focus:outline-none"
              type="password" value={confirmPwd} onChange={e => setConfirmPwd(e.target.value)} />
          </label>
        </div>
        <button type="submit" disabled={pwdSaving} className="btn-ghost px-6 py-2.5 text-sm">{pwdSaving ? "Updating..." : "Update password"}</button>
      </form>

      {/* Plan */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
        <h2 className="text-lg font-semibold text-white">Plan</h2>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <CheckCircleIcon size={18} className="text-mint-400" />
            <span className="text-white font-medium capitalize">{user.plan} Plan</span>
          </div>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${user.plan_status === "active" ? "bg-mint-500/10 text-mint-400" : "bg-sun-400/10 text-sun-400"}`}>
            {user.plan_status}
          </span>
        </div>
        {user.plan === "consumer" && (
          <p className="mt-4 text-sm text-white/45">
            Need more numbers and features?{" "}
            <Link href="/dashboard/billing" className="font-medium text-brand-300 hover:text-brand-200">Upgrade to Business</Link>
          </p>
        )}
      </div>

      {/* Softphone WebSocket URL */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Softphone WebSocket</h2>
          <p className="mt-1 text-sm text-white/45">
            WebSocket URL for the WebRTC softphone. Must point to the Asterisk WSS endpoint (port 8089).
            Change this if your PBX is on a different hostname.
          </p>
        </div>
        <div className="flex gap-3">
          <input
            className="flex-1 rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-sm font-mono text-white placeholder:text-white/20 focus:border-brand-500/50 focus:outline-none"
            value={wssUrl}
            onChange={(e) => { setWssUrl(e.target.value); setWssSaved(false); }}
            placeholder="wss://ws.zeus.innotel.us:8089/ws"
          />
          <button type="button" onClick={saveWssUrl} disabled={wssSaved}
            className={`btn-primary px-4 py-2 text-sm ${wssSaved ? "opacity-50" : ""}`}>
            {wssSaved ? "Saved ✓" : "Save"}
          </button>
          <button type="button" onClick={resetWssUrl}
            className="btn-ghost px-4 py-2 text-sm">Reset</button>
        </div>
        <p className="text-xs text-white/25">
          Current: <code className="text-brand-300">{localStorage.getItem(WSS_STORAGE_KEY) || defaultWss}</code>
          {localStorage.getItem(WSS_STORAGE_KEY) && <span className="text-sun-400"> (custom)</span>}
        </p>
      </div>

      {/* Integrations */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
        <h2 className="text-lg font-semibold text-white">Integrations</h2>
        <p className="mt-1 text-sm text-white/45">External services and API access.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {["VoIP.ms", "FreePBX", "AvantFax"].map(svc => (
            <div key={svc} className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
              <div className="flex items-center gap-2">
                <CheckCircleIcon size={14} className="text-mint-400" />
                <span className="text-sm font-medium text-white">{svc}</span>
              </div>
              <p className="mt-1 text-xs text-white/35">Connection active</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
