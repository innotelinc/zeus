"use client";

import { useState, useEffect } from "react";
import { api } from "@/lib/client-api";
import type { User } from "@/lib/types";
import { useToast } from "@/components/ToastProvider";

export default function AdminPage() {
  const { toast } = useToast();
  const [users, setUsers] = useState<User[]>([]);
  const [stats, setStats] = useState<{ total: number; business: number; consumer: number; admins: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);

  useEffect(() => {
    loadUsers();
  }, []);

  async function loadUsers() {
    try {
      const data = await api<{ users: User[]; stats: typeof stats }>("/api/admin/users");
      setUsers(data.users);
      setStats(data.stats);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load users");
    } finally {
      setLoading(false);
    }
  }

  async function updateUser(userId: string, updates: { plan?: string; role?: string | null }) {
    setUpdating(userId);
    try {
      await api("/api/admin/users", {
        method: "PATCH",
        body: JSON.stringify({ userId, ...updates }),
      });
      toast.success("User updated");
      loadUsers();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setUpdating(null);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold text-white">Admin Portal</h1>
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-10 text-center">
          <p className="text-sm text-white/40">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">Admin Portal</h1>
        <p className="mt-1 text-sm text-white/45">Manage users, plans, and system configuration.</p>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid gap-4 sm:grid-cols-4">
          {[
            { label: "Total Users", value: stats.total, color: "text-brand-300" },
            { label: "Business", value: stats.business, color: "text-mint-400" },
            { label: "Consumer", value: stats.consumer, color: "text-white/60" },
            { label: "Admins", value: stats.admins, color: "text-sun-400" },
          ].map((s) => (
            <div key={s.label} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5 text-center">
              <div className={`text-3xl font-bold ${s.color}`}>{s.value}</div>
              <div className="mt-1 text-xs text-white/40">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Users table */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">Users</h2>
          <button type="button" onClick={loadUsers} className="btn-ghost px-3 py-1.5 text-xs">
            Refresh
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-white/[0.06] text-xs text-white/40">
                <th className="pb-3 px-3 font-medium">Email</th>
                <th className="pb-3 px-3 font-medium">Name</th>
                <th className="pb-3 px-3 font-medium">Plan</th>
                <th className="pb-3 px-3 font-medium">Role</th>
                <th className="pb-3 px-3 font-medium">Created</th>
                <th className="pb-3 px-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                  <td className="py-3 px-3 font-mono text-xs text-white/70">{u.email}</td>
                  <td className="py-3 px-3 text-white/80">{u.name}</td>
                  <td className="py-3 px-3">
                    <select
                      className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-xs text-white outline-none"
                      value={u.plan}
                      onChange={(e) => updateUser(u.id, { plan: e.target.value })}
                      disabled={updating === u.id}
                    >
                      <option value="consumer">Consumer</option>
                      <option value="business">Business</option>
                    </select>
                  </td>
                  <td className="py-3 px-3">
                    <select
                      className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-xs text-white outline-none"
                      value={u.role ?? ""}
                      onChange={(e) => updateUser(u.id, { role: e.target.value || null })}
                      disabled={updating === u.id}
                    >
                      <option value="">User</option>
                      <option value="admin">Admin</option>
                    </select>
                  </td>
                  <td className="py-3 px-3 text-xs text-white/40">
                    {new Date(u.created_at).toLocaleDateString()}
                  </td>
                  <td className="py-3 px-3 text-right">
                    {updating === u.id && (
                      <span className="text-xs text-white/40">Saving...</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
