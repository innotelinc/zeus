"use client";

import { useState, useEffect } from "react";
import { api } from "@/lib/client-api";
import { useToast } from "@/components/ToastProvider";
import { PlusIcon, XIcon, TrashIcon } from "@/components/icons";

interface Reseller {
  id: string;
  name: string;
  brand_name: string | null;
  domain: string | null;
  plan_status: string;
  created_at: string;
}

export function ResellersSection() {
  const { toast } = useToast();
  const [resellers, setResellers] = useState<Reseller[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", brand_name: "", domain: "" });
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    try {
      const data = await api<{ resellers: Reseller[] }>("/api/admin/resellers");
      setResellers(data.resellers);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load resellers");
    } finally {
      setLoading(false);
    }
  }

  async function create() {
    if (!form.name.trim()) {
      toast.error("Reseller name is required");
      return;
    }
    setSaving(true);
    try {
      await api("/api/admin/resellers", {
        method: "POST",
        body: JSON.stringify(form),
      });
      toast.success("Reseller created — serve this domain to apply its brand.");
      setForm({ name: "", brand_name: "", domain: "" });
      setShowForm(false);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create reseller");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    setDeletingId(id);
    try {
      await api(`/api/admin/resellers?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      toast.success("Reseller removed");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete reseller");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">Resellers &amp; White-Label</h2>
          <p className="mt-1 text-sm text-white/45">
            Resellers get their own brand when users sign in through the reseller&apos;s domain.
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setShowForm(!showForm); }}
          className="btn-primary px-3 py-1.5 text-xs flex items-center gap-1"
        >
          {showForm ? <><XIcon size={13} /> Cancel</> : <><PlusIcon size={13} /> Add Reseller</>}
        </button>
      </div>

      {showForm && (
        <div className="mb-6 rounded-xl border border-brand-500/20 bg-brand-500/[0.04] p-5 animate-slide-up">
          <h3 className="text-sm font-semibold text-white mb-4">New Reseller</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-white/50">Name *</span>
              <input
                className="w-full rounded-xl border px-4 py-2.5 text-sm outline-none transition focus:border-brand-500/50"
                style={{ background: "var(--input-bg)", borderColor: "var(--input-border)", color: "var(--foreground)" }}
                placeholder="Acme Telecom"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-white/50">Brand name</span>
              <input
                className="w-full rounded-xl border px-4 py-2.5 text-sm outline-none transition focus:border-brand-500/50"
                style={{ background: "var(--input-bg)", borderColor: "var(--input-border)", color: "var(--foreground)" }}
                placeholder="Acme"
                value={form.brand_name}
                onChange={(e) => setForm({ ...form, brand_name: e.target.value })}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-white/50">Domain</span>
              <input
                className="w-full rounded-xl border px-4 py-2.5 text-sm outline-none transition focus:border-brand-500/50"
                style={{ background: "var(--input-bg)", borderColor: "var(--input-border)", color: "var(--foreground)" }}
                placeholder="acme.com"
                value={form.domain}
                onChange={(e) => setForm({ ...form, domain: e.target.value })}
              />
            </label>
          </div>
          <button type="button" onClick={create} disabled={saving}
            className="btn-primary mt-4 px-5 py-2 text-sm">
            {saving ? "Creating..." : "Create Reseller"}
          </button>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-white/40">Loading...</p>
      ) : resellers.length === 0 ? (
        <p className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-5 text-sm text-white/40">
          No resellers yet — add one to start white-labeling.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-white/[0.06] text-xs text-white/40">
                <th className="pb-3 px-3 font-medium">Name</th>
                <th className="pb-3 px-3 font-medium">Brand</th>
                <th className="pb-3 px-3 font-medium">Domain</th>
                <th className="pb-3 px-3 font-medium">Status</th>
                <th className="pb-3 px-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {resellers.map((r) => (
                <tr key={r.id} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                  <td className="py-3 px-3 text-white/80">{r.name}</td>
                  <td className="py-3 px-3 font-mono text-xs text-white/60">{r.brand_name ?? "—"}</td>
                  <td className="py-3 px-3 font-mono text-xs text-white/60">{r.domain ?? "—"}</td>
                  <td className="py-3 px-3 text-xs text-mint-400">{r.plan_status}</td>
                  <td className="py-3 px-3 text-right">
                    {deletingId === r.id ? (
                      <span className="text-xs text-white/40">Deleting...</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => remove(r.id)}
                        className="rounded-lg p-1.5 text-white/25 hover:text-rose-400 hover:bg-rose-500/10 transition"
                        title="Delete reseller"
                      >
                        <TrashIcon size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}