"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { api, fmtTime } from "@/lib/client-api";
import type { SmsConversation, SmsMessage, PhoneNumber, Contact } from "@/lib/types";
import { useToast } from "@/components/ToastProvider";
import { SendIcon, PlusIcon, MessageIcon, PhoneIcon, UserIcon, SearchIcon, XIcon } from "@/components/icons";

interface Props {
  conversations: SmsConversation[];
  numbers: PhoneNumber[];
  prefillPhone?: string;
}

export default function MessagesSection({ conversations: initialConvs, numbers, prefillPhone }: Props) {
  const { toast } = useToast();
  const [conversations, setConversations] = useState(initialConvs);
  const [activeConv, setActiveConv] = useState<SmsConversation | null>(null);
  const [messages, setMessages] = useState<SmsMessage[]>([]);
  const [msgText, setMsgText] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);

  // New conversation
  const [showNew, setShowNew] = useState(false);
  const [newPhone, setNewPhone] = useState("");
  const [newBody, setNewBody] = useState("");
  const [toDid, setToDid] = useState(numbers[0]?.id ?? "");
  const [matchedContact, setMatchedContact] = useState<Contact | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const prefillDone = useRef(false);

  // Handle prefill from contacts deep-link
  useEffect(() => {
    if (prefillPhone && !prefillDone.current) {
      prefillDone.current = true;
      setNewPhone(prefillPhone);
      setShowNew(true);
      setActiveConv(null);
      lookupContact(prefillPhone);
    }
  }, [prefillPhone]);

  const lookupContact = useCallback(async (phone: string) => {
    const clean = phone.replace(/\D/g, "");
    if (clean.length < 7) { setMatchedContact(null); return; }
    try {
      const res = await api<{ contacts: Contact[] }>("/api/contacts");
      const match = res.contacts.find(c => c.phone.replace(/\D/g, "") === clean);
      setMatchedContact(match ?? null);
    } catch { setMatchedContact(null); }
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  async function openConversation(conv: SmsConversation) {
    setActiveConv(conv);
    setShowNew(false);
    setLoadingMsgs(true);
    if (conv.unread_count > 0) {
      api(`/api/messages/${conv.id}/read`, { method: "POST" }).catch(() => {});
      setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, unread_count: 0 } : c));
    }
    try {
      const res = await api<{ messages: SmsMessage[] }>(`/api/messages/${conv.id}`);
      setMessages(res.messages.reverse());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load messages");
    } finally {
      setLoadingMsgs(false);
    }
  }

  async function sendMessage() {
    if (!msgText.trim() || !activeConv) return;
    setSending(true);
    try {
      const res = await api<{ message: SmsMessage }>("/api/messages/send", {
        method: "POST",
        body: JSON.stringify({
          conversation_id: activeConv.id,
          to_number: activeConv.contact_phone,
          from_did_id: activeConv.phone_number_id ?? numbers[0]?.id,
          body: msgText.trim(),
        }),
      });
      setMessages(prev => [...prev, res.message]);
      setMsgText("");
      setConversations(prev => prev.map(c => c.id === activeConv.id
        ? { ...c, last_message_text: msgText.trim(), last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() }
        : c
      ));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to send");
    } finally {
      setSending(false);
    }
  }

  async function startNewConversation() {
    if (!newPhone.trim() || !newBody.trim() || !toDid) { toast.error("Please fill in all fields"); return; }
    setSending(true);
    try {
      const res = await api<{ message: SmsMessage; conversation: SmsConversation }>("/api/messages/send", {
        method: "POST",
        body: JSON.stringify({ to_number: newPhone.trim(), from_did_id: toDid, body: newBody.trim() }),
      });
      setConversations(prev => [res.conversation, ...prev]);
      setActiveConv(res.conversation);
      setMessages([res.message]);
      setShowNew(false);
      setNewPhone(""); setNewBody("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to send");
    } finally {
      setSending(false);
    }
  }

  function closeConversation() { setActiveConv(null); setMessages([]); }

  return (
    <div className="flex gap-0 h-full rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
      {/* Sidebar */}
      <div className="w-80 shrink-0 border-r border-white/[0.06] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-white/[0.06]">
          <h2 className="text-sm font-semibold text-white">Messages</h2>
          <button type="button" onClick={() => { setShowNew(true); setActiveConv(null); }}
            className="rounded-lg p-1.5 text-white/40 transition hover:text-white hover:bg-white/[0.06]" title="New message">
            <PlusIcon size={17} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {conversations.length === 0 ? (
            <div className="flex flex-col items-center p-8 text-center">
              <MessageIcon size={32} className="text-white/10 mb-3" />
              <p className="text-sm text-white/40">No conversations yet</p>
            </div>
          ) : conversations.map(conv => (
            <button key={conv.id} type="button" onClick={() => openConversation(conv)}
              className={`w-full text-left px-4 py-3.5 border-b border-white/[0.03] transition hover:bg-white/[0.03] ${
                activeConv?.id === conv.id ? "bg-brand-500/10 border-l-2 border-l-brand-500" : ""}`}>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-white truncate">{conv.contact_name ?? conv.contact_phone}</span>
                {conv.last_message_at && <span className="text-[10px] text-white/30 shrink-0 ml-2">{fmtTime(conv.last_message_at)}</span>}
              </div>
              <div className="mt-0.5 flex items-center justify-between">
                <span className="text-xs text-white/40 truncate">{conv.last_message_text ?? "No messages"}</span>
                {conv.unread_count > 0 && (
                  <span className="rounded-full bg-brand-500 px-1.5 py-0.5 text-[10px] font-semibold text-white shrink-0 ml-2">{conv.unread_count}</span>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0">
        {showNew ? (
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="w-full max-w-md space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-white">New Message</h3>
                <button type="button" onClick={() => { setShowNew(false); setNewPhone(""); setNewBody(""); }}
                  className="rounded-lg p-1.5 text-white/30 hover:text-white/60"><XIcon size={18} /></button>
              </div>
              {numbers.length > 1 && (
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-white/50">From</span>
                  <select className="w-full rounded-xl border px-4 py-2.5 text-sm outline-none transition focus:border-brand-500/50"
                    style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--foreground)' }}
                    value={toDid} onChange={e => setToDid(e.target.value)}>
                    {numbers.map(n => <option key={n.id} value={n.id}>{n.did}</option>)}
                  </select>
                </label>
              )}
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-white/50">To</span>
                <input className="w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:border-brand-500/50 focus:outline-none"
                  type="tel" placeholder="+1 555 123 4567" value={newPhone}
                  onChange={e => { setNewPhone(e.target.value); lookupContact(e.target.value); }} />
                {matchedContact && <p className="text-xs text-mint-400 flex items-center gap-1"><span className="inline-block h-1 w-1 rounded-full bg-mint-400" />{matchedContact.name}</p>}
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-white/50">Message</span>
                <textarea className="w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-3 text-sm text-white placeholder:text-white/20 focus:border-brand-500/50 focus:outline-none resize-none min-h-[100px]"
                  placeholder="Type your message..." value={newBody} onChange={e => setNewBody(e.target.value)} />
              </label>
              <button type="button" onClick={startNewConversation} disabled={sending}
                className="btn-primary w-full py-2.5 text-sm flex items-center justify-center gap-2">
                {sending ? "Sending..." : "Send"} <SendIcon size={14} />
              </button>
            </div>
          </div>
        ) : activeConv ? (
          <>
            {/* Header */}
            <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-white/[0.06]">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-500/15">
                  <PhoneIcon size={16} className="text-brand-300" />
                </div>
                <div>
                  <div className="text-sm font-medium text-white">{activeConv.contact_name ?? activeConv.contact_phone}</div>
                  <div className="text-xs text-white/35">{activeConv.contact_phone}</div>
                </div>
              </div>
              <button type="button" onClick={closeConversation}
                className="rounded-lg p-1.5 text-white/30 hover:text-white/60"><XIcon size={16} /></button>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
              {loadingMsgs ? (
                <div className="flex items-center justify-center h-full"><p className="text-sm text-white/30">Loading...</p></div>
              ) : messages.length === 0 ? (
                <div className="flex items-center justify-center h-full"><p className="text-sm text-white/35">No messages yet</p></div>
              ) : messages.map(msg => (
                <div key={msg.id} className={`flex ${msg.direction === "outbound" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm ${
                    msg.direction === "outbound" ? "bg-brand-500/20 text-white rounded-br-md" : "bg-white/[0.06] text-white/90 rounded-bl-md"}`}>
                    <p className="whitespace-pre-wrap break-words">{msg.body}</p>
                    <p className={`mt-1 text-[10px] ${msg.direction === "outbound" ? "text-brand-300/60" : "text-white/30"}`}>
                      {fmtTime(msg.created_at)}
                      {msg.status === "delivered" && " · Delivered"}
                    </p>
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>

            {/* Compose */}
            <div className="border-t border-white/[0.06] px-5 py-3">
              <div className="flex gap-2">
                <input
                  className="flex-1 rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:border-brand-500/50 focus:outline-none"
                  placeholder="Type a message..."
                  value={msgText}
                  onChange={e => setMsgText(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                />
                <button type="button" onClick={sendMessage} disabled={sending || !msgText.trim()}
                  className="btn-primary px-4 py-2.5 flex items-center"><SendIcon size={16} /></button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-8">
            <ContactsQuickPick onSelect={(phone, name) => {
              setNewPhone(phone);
              setMatchedContact({ id: "", user_id: "", name, phone, email: null, notes: null, created_at: "", updated_at: "" } as Contact);
              setShowNew(true);
            }} />
            <p className="text-white/25 text-xs mt-6 mb-3">or</p>
            <button type="button" onClick={() => setShowNew(true)}
              className="btn-primary px-5 py-2 text-sm flex items-center gap-2"><PlusIcon size={14} /> New message</button>
          </div>
        )}
      </div>
    </div>
  );
}

function ContactsQuickPick({ onSelect }: { onSelect: (phone: string, name: string) => void }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    api<{ contacts: Contact[] }>("/api/contacts").then(r => setContacts(r.contacts.slice(0, 5))).catch(() => {}).finally(() => setLoaded(true));
  }, []);
  if (!loaded || contacts.length === 0) return null;
  return (
    <div className="w-full max-w-sm">
      <div className="flex items-center gap-2 mb-2">
        <UserIcon size={14} className="text-white/30" />
        <span className="text-xs font-medium text-white/35">Quick message</span>
      </div>
      <div className="space-y-1">
        {contacts.map(c => (
          <button key={c.id} type="button" onClick={() => onSelect(c.phone, c.name)}
            className="flex w-full items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-2.5 text-left transition hover:bg-white/[0.05] hover:border-brand-500/30">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-500/15 text-xs font-semibold text-brand-300">{c.name.charAt(0).toUpperCase()}</span>
            <div className="min-w-0"><div className="text-sm font-medium text-white truncate">{c.name}</div><div className="text-xs text-white/35">{c.phone}</div></div>
            <MessageIcon size={14} className="shrink-0 ml-auto text-white/20" />
          </button>
        ))}
      </div>
    </div>
  );
}
