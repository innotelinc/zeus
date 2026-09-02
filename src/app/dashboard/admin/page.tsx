"use client";

import { useState, useEffect } from "react";
import { api } from "@/lib/client-api";
import type { User, PlanInfo } from "@/lib/types";
import { useToast } from "@/components/ToastProvider";
import { PlusIcon, XIcon, TrashIcon } from "@/components/icons";
import { ResellersSection } from "@/components/dashboard/ResellersSection";

export default function AdminPage() {
  const { toast } = useToast();
  const [users, setUsers] = useState<User[]>([]);
  const [stats, setStats] = useState<{ total: number; business: number; consumer: number; admins: number } | null>(null);
  const [plans, setPlans] = useState<PlanInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);
  const [editingPlan, setEditingPlan] = useState<string | null>(null);
  const [planForm, setPlanForm] = useState({ name: "", amount: "", max_numbers: "" });

  // Create user form
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ email: "", password: "", name: "", plan: "consumer", role: "" });
  const [creating, setCreating] = useState(false);

  // Delete confirmation
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    loadAll();
  }, []);

  async function loadAll() {
    try {
      const [userData, planData] = await Promise.all([
        api<{ users: User[]; stats: typeof stats }>("/api/admin/users"),
        api<{ plans: PlanInfo[] }>("/api/admin/plans"),
      ]);
      setUsers(userData.users);
      setStats(userData.stats);
      setPlans(planData.plans);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }

  async function updateUser(userId: string, updates: { plan?: string; role?: string | null }) {
    setUpdating(userId);
    try {
      await api("/api/admin/users", { method: "PATCH", body: JSON.stringify({ userId, ...updates }) });
      toast.success("User updated");
      loadAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setUpdating(null);
    }
  }

  async function createUser() {
    if (!createForm.email || !createForm.password) {
      toast.error("Email and password are required");
      return;
    }
    setCreating(true);
    try {
      await api("/api/admin/users", {
        method: "POST",
        body: JSON.stringify(createForm),
      });
      toast.success("User created");
      setShowCreate(false);
      setCreateForm({ email: "", password: "", name: "", plan: "consumer", role: "" });
      loadAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create user");
    } finally {
      setCreating(false);
    }
  }

  async function deleteUser(userId: string) {
    setDeleting(true);
    try {
      await api(`/api/admin/users?userId=${encodeURIComponent(userId)}`, { method: "DELETE" });
      toast.success("User deleted");
      setDeleteConfirm(null);
      loadAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete user");
    } finally {
      setDeleting(false);
    }
  }

  function startEditPlan(p: PlanInfo) {
    setEditingPlan(p.id);
    setPlanForm({ name: p.name, amount: String(p.amount), max_numbers: String(p.max_numbers) });
  }

  async function savePlan(planId: string) {
    setUpdating("plan-" + planId);
    try {
      await api("/api/admin/plans", {
        method: "PATCH",
        body: JSON.stringify({
          id: planId,
          name: planForm.name,
          amount: Math.round(parseFloat(planForm.amount) * 100),
          max_numbers: parseInt(planForm.max_numbers, 10),
          syncStripe: true,
        }),
      });
      toast.success("Plan updated — Stripe price synced");
      setEditingPlan(null);
      loadAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update plan");
    } finally {
      setUpdating(null);
    }
  }

  function formatPrice(cents: number, interval: string) {
    return `$${(cents / 100).toFixed(2)}/${interval === "year" ? "yr" : "mo"}`;
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

      {/* Plans management */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Plans & Pricing</h2>
        <p className="mb-4 text-sm text-white/45">Edit plan names and prices. Stripe prices are synced automatically when you save.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {plans.map((p) => (
            <div key={p.id} className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-5">
              {editingPlan === p.id ? (
                <div className="space-y-3">
                  <input
                    className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm text-white placeholder:text-white/20 focus:border-brand-500/50 focus:outline-none"
                    placeholder="Plan name" value={planForm.name} onChange={(e) => setPlanForm({ ...planForm, name: e.target.value })}
                  />
                  <div className="flex gap-2">
                    <input
                      className="flex-1 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm text-white placeholder:text-white/20 focus:border-brand-500/50 focus:outline-none"
                      placeholder="Price (dollars)" value={planForm.amount} onChange={(e) => setPlanForm({ ...planForm, amount: e.target.value })}
                    />
                    <input
                      className="w-20 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm text-white placeholder:text-white/20 focus:border-brand-500/50 focus:outline-none"
                      placeholder="DIDs" value={planForm.max_numbers} onChange={(e) => setPlanForm({ ...planForm, max_numbers: e.target.value })}
                    />
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => savePlan(p.id)} disabled={updating === "plan-" + p.id}
                      className="btn-primary px-3 py-1.5 text-xs">
                      {updating === "plan-" + p.id ? "Saving..." : "Save & Sync Stripe"}
                    </button>
                    <button type="button" onClick={() => setEditingPlan(null)} className="btn-ghost px-3 py-1.5 text-xs">Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-lg font-bold text-white">{p.name}</span>
                    <button type="button" onClick={() => startEditPlan(p)} className="btn-ghost px-2 py-1 text-xs">Edit</button>
                  </div>
                  <div className="text-2xl font-bold text-brand-300">{formatPrice(p.amount, p.interval)}</div>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-white/40">
                    <span>{p.max_numbers} phone number{p.max_numbers !== 1 ? "s" : ""}</span>
                    <span>·</span>
                    <span>Stripe: {p.stripe_price_id ? "✓ synced" : "✗ not synced"}</span>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Resellers & white-label */}
      <ResellersSection />

      {/* Users table */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">Users</h2>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => { setShowCreate(!showCreate); setDeleteConfirm(null); }} className="btn-primary px-3 py-1.5 text-xs flex items-center gap-1">
              <PlusIcon size={13} /> {showCreate ? "Cancel" : "Add User"}
            </button>
            <button type="button" onClick={loadAll} className="btn-ghost px-3 py-1.5 text-xs">Refresh</button>
          </div>
        </div>

        {/* Create user form */}
        {showCreate && (
          <div className="mb-6 rounded-xl border border-brand-500/20 bg-brand-500/[0.04] p-5 animate-slide-up">
            <h3 className="text-sm font-semibold text-white mb-4">Create New User</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-white/50">Email *</span>
                <input className="w-full rounded-xl border px-4 py-2.5 text-sm outline-none transition focus:border-brand-500/50"
                  style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--foreground)' }}
                  type="email" placeholder="user@example.com" value={createForm.email}
                  onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })} />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-white/50">Password *</span>
                <input className="w-full rounded-xl border px-4 py-2.5 text-sm outline-none transition focus:border-brand-500/50"
                  style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--foreground)' }}
                  type="password" placeholder="Min 8 characters" value={createForm.password}
                  onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })} />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-white/50">Name</span>
                <input className="w-full rounded-xl border px-4 py-2.5 text-sm outline-none transition focus:border-brand-500/50"
                  style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--foreground)' }}
                  placeholder="John Doe" value={createForm.name}
                  onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-white/50">Plan</span>
                <select className="w-full rounded-xl border px-4 py-2.5 text-sm outline-none transition focus:border-brand-500/50"
                  style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--foreground)' }}
                  value={createForm.plan} onChange={(e) => setCreateForm({ ...createForm, plan: e.target.value })}>
                  {plans.map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
                </select>
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-white/50">Role</span>
                <select className="w-full rounded-xl border px-4 py-2.5 text-sm outline-none transition focus:border-brand-500/50"
                  style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--foreground)' }}
                  value={createForm.role} onChange={(e) => setCreateForm({ ...createForm, role: e.target.value })}>
                  <option value="">User</option>
                  <option value="admin">Admin</option>
                </select>
              </label>
            </div>
            <button type="button" onClick={createUser} disabled={creating}
              className="btn-primary mt-4 px-5 py-2 text-sm">
              {creating ? "Creating..." : "Create User"}
            </button>
          </div>
        )}

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
                      className="rounded-lg border px-2 py-1 text-xs outline-none transition focus:border-brand-500/50"
                      style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--foreground)' }}
                      value={u.plan}
                      onChange={(e) => updateUser(u.id, { plan: e.target.value })}
                      disabled={updating === u.id}
                    >
                      {plans.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-3 px-3">
                    <select
                      className="rounded-lg border px-2 py-1 text-xs outline-none transition focus:border-brand-500/50"
                      style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--foreground)' }}
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
                    {updating === u.id ? (
                      <span className="text-xs text-white/40">Saving...</span>
                    ) : (
                      <>
                        {deleteConfirm === u.id ? (
                          <span className="flex items-center justify-end gap-2 text-xs">
                            <span className="text-rose-300">Delete?</span>
                            <button type="button" onClick={() => deleteUser(u.id)} disabled={deleting}
                              className="rounded bg-rose-500 px-2 py-0.5 text-white hover:bg-rose-600 transition">Yes</button>
                            <button type="button" onClick={() => setDeleteConfirm(null)}
                              className="rounded border px-2 py-0.5 transition"
                              style={{ borderColor: 'var(--input-border)', color: 'var(--foreground)' }}>No</button>
                          </span>
                        ) : (
                          <button type="button" onClick={() => { setDeleteConfirm(u.id); setShowCreate(false); }}
                            className="rounded-lg p-1.5 text-white/25 hover:text-rose-400 hover:bg-rose-500/10 transition"
                            title="Delete user">
                            <TrashIcon size={14} />
                          </button>
                        )}
                      </>
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
