"use client";

import { useState } from "react";
import { api } from "@/lib/client-api";
import { CheckCircleIcon } from "@/components/icons";
import { useToast } from "@/components/ToastProvider";
import type { User } from "@/lib/types";

interface Props {
  user: User;
}

export default function SettingsClient({ user }: Props) {
  const { toast } = useToast();

  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [phone, setPhone] = useState(user.phone ?? "");
  const [country, setCountry] = useState(user.country);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [saving, setSaving] = useState(false);
  const [pwdSaving, setPwdSaving] = useState(false);

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api("/api/settings/profile", {
        method: "PATCH",
        body: JSON.stringify({ name, email, phone: phone || null, country }),
      });
      toast.success("Profile updated successfully.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save profile");
    } finally {
      setSaving(false);
    }
  }

  async function handleUpdatePassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error("New passwords do not match.");
      return;
    }
    if (newPassword.length < 8) {
      toast.error("Password must be at least 8 characters.");
      return;
    }
    setPwdSaving(true);
    try {
      await api("/api/settings/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast.success("Password updated successfully.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update password");
    } finally {
      setPwdSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">Settings</h1>
        <p className="mt-1 text-sm text-white/45">Manage your account settings.</p>
      </div>

      {/* Profile */}
      <form onSubmit={handleSaveProfile} className="card-surface rounded-2xl p-6 space-y-4">
        <h2 className="text-lg font-semibold text-white">Profile</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="input-label">Name</span>
            <input className="input-base" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block">
            <span className="input-label">Email</span>
            <input className="input-base" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="block">
            <span className="input-label">Phone</span>
            <input className="input-base" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 555 123 4567" />
          </label>
          <label className="block">
            <span className="input-label">Country</span>
            <input className="input-base" value={country} onChange={(e) => setCountry(e.target.value)} />
          </label>
        </div>
        <button type="submit" disabled={saving} className="btn-primary px-6 py-2.5 text-sm">
          {saving ? "Saving..." : "Save changes"}
        </button>
      </form>

      {/* Password */}
      <form onSubmit={handleUpdatePassword} className="card-surface rounded-2xl p-6 space-y-4">
        <h2 className="text-lg font-semibold text-white">Change Password</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="input-label">Current password</span>
            <input className="input-base" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
          </label>
          <label className="block">
            <span className="input-label">New password</span>
            <input className="input-base" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          </label>
          <label className="block">
            <span className="input-label">Confirm new password</span>
            <input className="input-base" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
          </label>
        </div>
        <button type="submit" disabled={pwdSaving} className="btn-ghost px-6 py-2.5 text-sm">
          {pwdSaving ? "Updating..." : "Update password"}
        </button>
      </form>

      {/* Plan info */}
      <div className="card-surface rounded-2xl p-6">
        <h2 className="text-lg font-semibold text-white">Plan</h2>
        <div className="mt-3 flex items-center gap-6">
          <div className="flex items-center gap-2">
            <CheckCircleIcon size={18} className="text-mint-400" />
            <span className="text-white font-medium capitalize">{user.plan} Plan</span>
          </div>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
            user.plan_status === "active" ? "bg-mint-500/10 text-mint-400" : "bg-sun-400/10 text-sun-400"
          }`}>
            {user.plan_status}
          </span>
        </div>
        {user.plan === "consumer" && (
          <p className="mt-4 text-sm text-white/45">
            Need more numbers and features?{" "}
            <a
              href="/dashboard/billing"
              className="font-medium text-brand-300 hover:text-brand-200"
            >
              Upgrade to Business
            </a>
          </p>
        )}
      </div>

      {/* API & integrations */}
      <div className="card-surface rounded-2xl p-6">
        <h2 className="text-lg font-semibold text-white">API & Integrations</h2>
        <p className="mt-1 text-sm text-white/45">
          External integrations and API access for advanced users.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
            <div className="flex items-center gap-2">
              <CheckCircleIcon size={14} className="text-mint-400" />
              <span className="text-sm font-medium text-white">VoIP.ms</span>
            </div>
            <p className="mt-1 text-xs text-white/35">Provider connection active</p>
          </div>
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
            <div className="flex items-center gap-2">
              <CheckCircleIcon size={14} className="text-mint-400" />
              <span className="text-sm font-medium text-white">FreePBX</span>
            </div>
            <p className="mt-1 text-xs text-white/35">PBX connection active</p>
          </div>
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
            <div className="flex items-center gap-2">
              <CheckCircleIcon size={14} className="text-mint-400" />
              <span className="text-sm font-medium text-white">AvantFax</span>
            </div>
            <p className="mt-1 text-xs text-white/35">Fax service active</p>
          </div>
        </div>
      </div>
    </div>
  );
}
