"use client";

import { useState } from "react";
import { api } from "@/lib/client-api";
import type { Contact } from "@/lib/types";
import { useToast } from "@/components/ToastProvider";
import { PlusIcon, UserIcon, TrashIcon, MessageIcon, PhoneIcon, MailIcon, SearchIcon, XIcon } from "@/components/icons";
import Link from "next/link";

interface Props {
  contacts: Contact[];
}

export default function ContactsSection({ contacts: initialContacts }: Props) {
  const { toast } = useToast();
  const [contacts, setContacts] = useState(initialContacts);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Form
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [form, setForm] = useState({ name: "", phone: "", email: "", notes: "" });

  const filtered = search
    ? contacts.filter(c =>
        c.name.toLowerCase().includes(search.toLowerCase()) ||
        c.phone.includes(search)
      )
    : contacts;

  function openAdd() {
    setForm({ name: "", phone: "", email: "", notes: "" });
    setEditing(null);
    setShowForm(true);
  }

  function openEdit(c: Contact) {
    setForm({ name: c.name, phone: c.phone, email: c.email ?? "", notes: c.notes ?? "" });
    setEditing(c);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditing(null);
  }

  async function saveContact() {
    if (!form.name.trim() || !form.phone.trim()) {
      toast.error("Name and phone are required");
      return;
    }
    const id = editing?.id;
    setLoading(id ?? "new");
    try {
      if (id) {
        const res = await api<{ contact: Contact }>(`/api/contacts/${id}`, {
          method: "PATCH",
          body: JSON.stringify(form),
        });
        setContacts(prev => prev.map(c => c.id === id ? res.contact : c).sort((a, b) => a.name.localeCompare(b.name)));
        toast.success("Contact updated.");
      } else {
        const res = await api<{ contact: Contact }>("/api/contacts", {
          method: "POST",
          body: JSON.stringify(form),
        });
        setContacts(prev => [res.contact, ...prev].sort((a, b) => a.name.localeCompare(b.name)));
        toast.success("Contact added.");
      }
      closeForm();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setLoading(null);
    }
  }

  async function deleteContact(id: string) {
    setLoading(id);
    try {
      await api(`/api/contacts/${id}`, { method: "DELETE" });
      setContacts(prev => prev.filter(c => c.id !== id));
      setConfirmDelete(null);
      toast.success("Contact deleted.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete");
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">Contacts</h1>
          <p className="mt-1 text-sm text-white/45">Manage your contacts. Names sync to SMS conversations automatically.</p>
        </div>
        <button type="button" onClick={openAdd} className="btn-primary flex items-center gap-2 px-4 py-2.5 text-sm">
          <PlusIcon size={15} />
          Add contact
        </button>
      </div>

      {/* Form */}
      {showForm && (
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-white">{editing ? "Edit Contact" : "New Contact"}</h3>
            <button type="button" onClick={closeForm} className="rounded-lg p-1.5 text-white/30 hover:text-white/60 transition-colors">
              <XIcon size={18} />
            </button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-white/50">Name *</span>
              <input className="w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:border-brand-500/50 focus:outline-none"
                placeholder="Jane Smith" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-white/50">Phone *</span>
              <input className="w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:border-brand-500/50 focus:outline-none"
                type="tel" placeholder="+1 555 123 4567" value={form.phone} onChange={e => setForm(p => ({ ...p, phone: e.target.value }))} />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-white/50">Email</span>
              <input className="w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:border-brand-500/50 focus:outline-none"
                type="email" placeholder="jane@example.com" value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-white/50">Notes</span>
              <input className="w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:border-brand-500/50 focus:outline-none"
                placeholder="Optional..." value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
            </label>
          </div>
          <div className="flex gap-3">
            <button type="button" onClick={saveContact} disabled={loading !== null}
              className="btn-primary px-6 py-2.5 text-sm">{loading === (editing?.id ?? "new") ? "Saving..." : editing ? "Save changes" : "Add contact"}</button>
            <button type="button" onClick={closeForm} className="btn-ghost px-6 py-2.5 text-sm">Cancel</button>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {confirmDelete && (
        <div className="rounded-2xl border border-rose-500/20 bg-rose-500/5 p-6 text-center">
          <p className="font-medium text-white">Delete this contact?</p>
          <p className="mt-1 text-sm text-white/40">This cannot be undone. Conversation history will be preserved.</p>
          <div className="mt-4 flex justify-center gap-3">
            <button type="button" onClick={() => deleteContact(confirmDelete)} disabled={loading === confirmDelete}
              className="rounded-xl bg-rose-500 px-6 py-2 text-sm font-medium text-white transition hover:bg-rose-600 disabled:opacity-50">
              {loading === confirmDelete ? "Deleting..." : "Delete"}
            </button>
            <button type="button" onClick={() => setConfirmDelete(null)} className="btn-ghost px-6 py-2 text-sm">Cancel</button>
          </div>
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <SearchIcon size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/25" />
        <input
          className="w-full rounded-xl border border-white/[0.08] bg-white/[0.03] py-2.5 pl-10 pr-4 text-sm text-white placeholder:text-white/25 focus:border-brand-500/30 focus:outline-none"
          placeholder="Search contacts..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center rounded-3xl border border-white/[0.06] bg-white/[0.02] p-12 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/[0.05]">
            <UserIcon size={26} className="text-white/25" />
          </div>
          <h3 className="mt-4 text-lg font-semibold text-white">{search ? "No matches" : "No contacts yet"}</h3>
          <p className="mt-1 text-sm text-white/45">
            {search ? "Try a different search." : "Add contacts to see names instead of phone numbers in your messages."}
          </p>
          {!search && (
            <button type="button" onClick={openAdd} className="btn-primary mt-4 px-5 py-2 text-sm flex items-center gap-2">
              <PlusIcon size={14} /> Add your first contact
            </button>
          )}
        </div>
      ) : (
        <div className="divide-y divide-white/[0.04] rounded-2xl border border-white/[0.06] bg-white/[0.02]">
          {filtered.map(c => (
            <div key={c.id} className="flex items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-white/[0.02]">
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-500/15">
                  <span className="text-sm font-semibold text-brand-300">{c.name.charAt(0).toUpperCase()}</span>
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-white truncate">{c.name}</div>
                  <div className="flex items-center gap-3 text-xs text-white/40 mt-0.5">
                    <span className="flex items-center gap-1"><PhoneIcon size={11} />{c.phone}</span>
                    {c.email && <span className="flex items-center gap-1 truncate"><MailIcon size={11} />{c.email}</span>}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Link href={`/dashboard/messages?phone=${encodeURIComponent(c.phone)}`}
                  className="rounded-lg p-2 text-white/30 transition hover:text-brand-300 hover:bg-brand-500/10" title="Message">
                  <MessageIcon size={15} />
                </Link>
                <button type="button" onClick={() => openEdit(c)}
                  className="rounded-lg p-2 text-white/30 transition hover:text-white hover:bg-white/[0.06]" title="Edit">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                </button>
                <button type="button" onClick={() => setConfirmDelete(c.id)}
                  className="rounded-lg p-2 text-white/30 transition hover:text-rose-400 hover:bg-rose-500/10" title="Delete">
                  <TrashIcon size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-white/20">{contacts.length} contact{contacts.length !== 1 ? "s" : ""}</p>
    </div>
  );
}
