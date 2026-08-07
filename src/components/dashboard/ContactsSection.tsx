"use client";

import { useState } from "react";
import { api } from "@/lib/client-api";
import type { Contact } from "@/lib/types";
import { useToast } from "@/components/ToastProvider";
import {
  PlusIcon,
  UserIcon,
  TrashIcon,
  MessageIcon,
  PhoneIcon,
  MailIcon,
} from "@/components/icons";
import Link from "next/link";

interface Props {
  contacts: Contact[];
}

type FormMode = "closed" | "add" | "edit";

export default function ContactsSection({ contacts: initialContacts }: Props) {
  const { toast } = useToast();
  const [contacts, setContacts] = useState<Contact[]>(initialContacts);
  const [mode, setMode] = useState<FormMode>("closed");
  const [editId, setEditId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Form fields
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");

  function resetForm() {
    setName("");
    setPhone("");
    setEmail("");
    setNotes("");
    setEditId(null);
  }

  function openAdd() {
    resetForm();
    setMode("add");
  }

  function openEdit(contact: Contact) {
    setName(contact.name);
    setPhone(contact.phone);
    setEmail(contact.email ?? "");
    setNotes(contact.notes ?? "");
    setEditId(contact.id);
    setMode("edit");
  }

  function closeForm() {
    setMode("closed");
    resetForm();
  }

  async function saveContact() {
    if (!name.trim() || !phone.trim()) {
      toast.error("Name and phone number are required");
      return;
    }
    setLoading(true);

    try {
      if (mode === "add") {
        const res = await api<{ contact: Contact }>("/api/contacts", {
          method: "POST",
          body: JSON.stringify({ name: name.trim(), phone: phone.trim(), email: email.trim() || null, notes: notes.trim() || null }),
        });
        setContacts((prev) => {
          const next = [res.contact, ...prev];
          next.sort((a, b) => a.name.localeCompare(b.name));
          return next;
        });
        toast.success("Contact added.");
      } else if (mode === "edit" && editId) {
        const res = await api<{ contact: Contact }>(`/api/contacts/${editId}`, {
          method: "PATCH",
          body: JSON.stringify({ name: name.trim(), phone: phone.trim(), email: email.trim() || null, notes: notes.trim() || null }),
        });
        setContacts((prev) =>
          prev
            .map((c) => (c.id === editId ? res.contact : c))
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
        toast.success("Contact updated.");
      }
      closeForm();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save contact");
    } finally {
      setLoading(false);
    }
  }

  async function deleteContact(id: string) {
    setLoading(true);
    try {
      await api(`/api/contacts/${id}`, { method: "DELETE" });
      setContacts((prev) => prev.filter((c) => c.id !== id));
      setConfirmDelete(null);
      toast.success("Contact deleted.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete contact");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="card-surface rounded-2xl p-6 text-center animate-slide-up">
          <p className="text-white">Delete this contact?</p>
          <p className="mt-1 text-sm text-white/40">This cannot be undone. Conversation history will be preserved.</p>
          <div className="mt-4 flex justify-center gap-3">
            <button type="button" onClick={() => deleteContact(confirmDelete)} disabled={loading} className="btn-primary px-6 py-2 text-sm bg-rose-500">
              {loading ? "Deleting..." : "Delete"}
            </button>
            <button type="button" onClick={() => setConfirmDelete(null)} className="btn-ghost px-6 py-2 text-sm">Cancel</button>
          </div>
        </div>
      )}

      {/* Add/Edit form */}
      {mode !== "closed" && (
        <div className="card-surface rounded-2xl p-6 space-y-4 animate-slide-up">
          <h3 className="text-lg font-semibold text-white">
            {mode === "add" ? "New Contact" : "Edit Contact"}
          </h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="input-label">Name *</span>
              <input className="input-base" placeholder="Jane Smith" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="block">
              <span className="input-label">Phone *</span>
              <input className="input-base" type="tel" placeholder="+1 555 123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </label>
            <label className="block">
              <span className="input-label">Email</span>
              <input className="input-base" type="email" placeholder="jane@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="block">
              <span className="input-label">Notes</span>
              <input className="input-base" placeholder="Optional notes..." value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
          </div>
          <div className="flex gap-3">
            <button type="button" onClick={saveContact} disabled={loading} className="btn-primary px-6 py-2.5 text-sm">
              {loading ? "Saving..." : mode === "add" ? "Add contact" : "Save changes"}
            </button>
            <button type="button" onClick={closeForm} className="btn-ghost px-6 py-2.5 text-sm">Cancel</button>
          </div>
        </div>
      )}

      {/* Contact list */}
      <div className="card-surface rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between p-5 border-b border-white/[0.06]">
          <div>
            <h2 className="text-lg font-semibold text-white">Contacts</h2>
            <p className="text-sm text-white/40">{contacts.length} contact{contacts.length !== 1 ? "s" : ""}</p>
          </div>
          <button type="button" onClick={openAdd} className="btn-primary px-4 py-2 text-sm">
            <PlusIcon size={14} />
            Add contact
          </button>
        </div>

        {contacts.length === 0 ? (
          <div className="flex flex-col items-center p-10 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/[0.05]">
              <UserIcon size={26} className="text-white/25" />
            </div>
            <h3 className="mt-4 text-lg font-semibold text-white">No contacts yet</h3>
            <p className="mt-1 text-sm text-white/45">
              Add contacts to see names instead of phone numbers in your messages.
            </p>
            <button type="button" onClick={openAdd} className="btn-primary mt-4 px-5 py-2 text-sm">
              <PlusIcon size={14} />
              Add your first contact
            </button>
          </div>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {contacts.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between px-5 py-4 transition hover:bg-white/[0.02]"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-500/15">
                    <span className="text-sm font-semibold text-brand-300">
                      {c.name.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-white truncate">{c.name}</div>
                    <div className="flex items-center gap-3 text-xs text-white/40 mt-0.5">
                      <span className="flex items-center gap-1">
                        <PhoneIcon size={11} />
                        {c.phone}
                      </span>
                      {c.email && (
                        <span className="flex items-center gap-1 truncate">
                          <MailIcon size={11} />
                          {c.email}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Link
                    href={`/dashboard/messages?phone=${encodeURIComponent(c.phone)}`}
                    className="rounded-lg border border-white/[0.08] bg-white/[0.03] p-2 text-white/40 transition hover:text-brand-300 hover:border-brand-500/30"
                    title="Send message"
                  >
                    <MessageIcon size={14} />
                  </Link>
                  <button
                    type="button"
                    onClick={() => openEdit(c)}
                    className="rounded-lg border border-white/[0.08] bg-white/[0.03] p-2 text-white/40 transition hover:text-white"
                    title="Edit"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(c.id)}
                    className="rounded-lg border border-white/[0.08] bg-white/[0.03] p-2 text-white/40 transition hover:text-rose-300 hover:border-rose-500/30"
                    title="Delete"
                  >
                    <TrashIcon size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
