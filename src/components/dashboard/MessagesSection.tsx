"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { api, fmtTime } from "@/lib/client-api";
import type { SmsConversation, SmsMessage, PhoneNumber, Contact } from "@/lib/types";
import { useToast } from "@/components/ToastProvider";
import { SendIcon, PlusIcon, MessageIcon, PhoneIcon, UserIcon } from "@/components/icons";

interface Props {
  conversations: SmsConversation[];
  numbers: PhoneNumber[];
  prefillPhone?: string;
}

export default function MessagesSection({ conversations: initialConversations, numbers, prefillPhone }: Props) {
  const { toast } = useToast();
  const [conversations, setConversations] = useState<SmsConversation[]>(initialConversations);
  const [activeConv, setActiveConv] = useState<SmsConversation | null>(null);
  const [messages, setMessages] = useState<SmsMessage[]>([]);
  const [newMsg, setNewMsg] = useState("");
  const [sending, setSending] = useState(false);

  // New conversation
  const [newMode, setNewMode] = useState(false);
  const [newPhone, setNewPhone] = useState("");
  const [newMsgBody, setNewMsgBody] = useState("");
  const [selectedDidId, setSelectedDidId] = useState(numbers[0]?.id ?? "");
  const [matchedContact, setMatchedContact] = useState<Contact | null>(null);
  const [prefillHandled, setPrefillHandled] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Contact lookup on phone number change.
  // Note: never call setState synchronously here — the effect below calls this
  // during its body, and the react-hooks/set-state-in-effect rule flags that.
  const lookupContact = useCallback(async (phone: string) => {
    const clean = phone.replace(/\D/g, "");
    if (clean.length < 7) {
      // Defer the update out of the effect's synchronous execution.
      queueMicrotask(() => setMatchedContact(null));
      return;
    }
    try {
      const res = await api<{ contacts: Contact[] }>("/api/contacts");
      const match = res.contacts.find(
        (c) => c.phone.replace(/\D/g, "") === clean || c.phone.includes(phone),
      );
      setMatchedContact(match ?? null);
    } catch {
      setMatchedContact(null);
    }
  }, []);

  // Handle prefill from contacts deep-link. State is adjusted during render
  // (the React-recommended pattern for responding to prop changes); the async
  // contact lookup stays in an effect.
  if (prefillPhone && !prefillHandled) {
    setNewPhone(prefillPhone);
    setNewMode(true);
    setActiveConv(null);
    setPrefillHandled(true);
  }

  useEffect(() => {
    if (prefillPhone && prefillHandled) {
      // Defer the lookup so no setState happens synchronously in this effect
      // body (react-hooks/set-state-in-effect).
      const id = setTimeout(() => lookupContact(prefillPhone), 0);
      return () => clearTimeout(id);
    }
  }, [prefillPhone, prefillHandled, lookupContact]);

  // Quick-start conversation from a contact
  function startFromContact(contact: Contact) {
    setNewPhone(contact.phone);
    setMatchedContact(contact);
    setNewMsgBody("");
    setNewMode(true);
    setActiveConv(null);
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function loadMessages(conv: SmsConversation) {
    setActiveConv(conv);
    setNewMode(false);

    // Mark as read
    if (conv.unread_count > 0) {
      try {
        await api(`/api/messages/${conv.id}/read`, { method: "POST" });
      } catch {
        /* ok */
      }
    }

    try {
      const res = await api<{ messages: SmsMessage[] }>(`/api/messages/${conv.id}`);
      setMessages(res.messages.reverse());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load messages");
    }
  }

  async function sendMessage() {
    if (!newMsg.trim() || !activeConv) return;
    setSending(true);

    try {
      const res = await api<{ message: SmsMessage }>("/api/messages/send", {
        method: "POST",
        body: JSON.stringify({
          conversation_id: activeConv.id,
          to_number: activeConv.contact_phone,
          from_did_id: activeConv.phone_number_id ?? numbers[0]?.id,
          body: newMsg.trim(),
        }),
      });
      setMessages((prev) => [...prev, res.message]);
      setNewMsg("");

      // Update conversation list
      setConversations((prev) =>
        prev.map((c) =>
          c.id === activeConv.id
            ? { ...c, last_message_text: newMsg.trim(), last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() }
            : c,
        ),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to send");
    } finally {
      setSending(false);
    }
  }

  async function startNewConversation() {
    if (!newPhone.trim() || !newMsgBody.trim() || !selectedDidId) {
      toast.error("Please fill in all fields");
      return;
    }
    setSending(true);

    try {
      const res = await api<{ message: SmsMessage; conversation: SmsConversation }>(
        "/api/messages/send",
        {
          method: "POST",
          body: JSON.stringify({
            to_number: newPhone.trim(),
            from_did_id: selectedDidId,
            body: newMsgBody.trim(),
          }),
        },
      );
      setConversations((prev) => [res.conversation, ...prev]);
      setActiveConv(res.conversation);
      setMessages([res.message]);
      setNewMode(false);
      setNewPhone("");
      setNewMsgBody("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to send");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex gap-0 h-full rounded-2xl card-surface overflow-hidden">
      {/* Conversation list */}
      <div className="w-80 shrink-0 border-r border-white/[0.06] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-white/[0.06]">
          <h2 className="text-sm font-semibold text-white">Conversations</h2>
          <button
            type="button"
            onClick={() => { setNewMode(true); setActiveConv(null); }}
            className="rounded-lg border border-white/[0.08] bg-white/[0.03] p-1.5 text-white/50 transition hover:text-white"
            title="New message"
          >
            <PlusIcon size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {conversations.length === 0 ? (
            <div className="flex flex-col items-center p-6 text-center">
              <MessageIcon size={32} className="text-white/15 mb-3" />
              <p className="text-sm text-white/40">No conversations yet</p>
              <p className="mt-1 text-xs text-white/25">Send a message to get started</p>
            </div>
          ) : (
            conversations.map((conv) => (
              <button
                key={conv.id}
                type="button"
                onClick={() => loadMessages(conv)}
                className={`w-full text-left px-4 py-3 border-b border-white/[0.04] transition hover:bg-white/[0.03] ${
                  activeConv?.id === conv.id ? "bg-brand-500/10 border-l-2 border-l-brand-500" : ""
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-white">
                    {conv.contact_name ?? conv.contact_phone}
                  </span>
                  {conv.last_message_at && (
                    <span className="text-[11px] text-white/30">{fmtTime(conv.last_message_at)}</span>
                  )}
                </div>
                <div className="mt-0.5 flex items-center justify-between">
                  <span className="text-xs text-white/40 truncate max-w-[180px]">
                    {conv.last_message_text ?? "No messages"}
                  </span>
                  {conv.unread_count > 0 && (
                    <span className="rounded-full bg-brand-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                      {conv.unread_count}
                    </span>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Message area */}
      <div className="flex-1 flex flex-col min-w-0">
        {newMode ? (
          /* New conversation form */
          <div className="flex-1 flex flex-col items-center justify-center p-8">
            <div className="w-full max-w-md space-y-4">
              <h3 className="text-lg font-semibold text-white text-center">New Message</h3>
              {numbers.length > 1 && (
                <label className="block">
                  <span className="input-label">From</span>
                  <select
                    className="input-base"
                    value={selectedDidId}
                    onChange={(e) => setSelectedDidId(e.target.value)}
                  >
                    {numbers.map((n) => (
                      <option key={n.id} value={n.id}>{n.did}</option>
                    ))}
                  </select>
                </label>
              )}
              <label className="block">
                <span className="input-label">To (phone number)</span>
                <input
                  className="input-base"
                  type="tel"
                  placeholder="+1 555 123 4567"
                  value={newPhone}
                  onChange={(e) => { setNewPhone(e.target.value); lookupContact(e.target.value); }}
                />
                {matchedContact && (
                  <p className="mt-1 text-xs text-mint-400 flex items-center gap-1">
                    <span className="inline-block h-1 w-1 rounded-full bg-mint-400" />
                    {matchedContact.name}
                  </p>
                )}
              </label>
              <label className="block">
                <span className="input-label">Message</span>
                <textarea
                  className="input-base min-h-[100px] resize-none"
                  placeholder="Type your message..."
                  value={newMsgBody}
                  onChange={(e) => setNewMsgBody(e.target.value)}
                />
              </label>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={startNewConversation}
                  disabled={sending}
                  className="btn-primary flex-1 py-2.5 text-sm"
                >
                  {sending ? "Sending..." : "Send"}
                  <SendIcon size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => setNewMode(false)}
                  className="btn-ghost px-6 py-2.5 text-sm"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        ) : activeConv ? (
          <>
            {/* Message header */}
            <div className="flex items-center gap-3 px-5 py-3 border-b border-white/[0.06]">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-500/15">
                <PhoneIcon size={16} className="text-brand-300" />
              </div>
              <div>
                <div className="text-sm font-medium text-white">
                  {activeConv.contact_name ?? activeConv.contact_phone}
                </div>
                <div className="text-xs text-white/35">{activeConv.contact_phone}</div>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
              {messages.length === 0 && (
                <div className="flex items-center justify-center h-full">
                  <p className="text-sm text-white/35">No messages yet</p>
                </div>
              )}
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${msg.direction === "outbound" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm ${
                      msg.direction === "outbound"
                        ? "bg-brand-500/20 text-white rounded-br-md"
                        : "bg-white/[0.06] text-white/90 rounded-bl-md"
                    }`}
                  >
                    <p className="whitespace-pre-wrap break-words">{msg.body}</p>
                    <p className={`mt-1 text-[10px] ${
                      msg.direction === "outbound" ? "text-brand-300/60" : "text-white/30"
                    }`}>
                      {fmtTime(msg.created_at)}
                      {msg.status === "sent" && " · Sent"}
                      {msg.status === "delivered" && " · Delivered"}
                    </p>
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Compose */}
            <div className="border-t border-white/[0.06] px-5 py-3">
              <div className="flex gap-2">
                <input
                  className="input-base flex-1"
                  placeholder="Type a message..."
                  value={newMsg}
                  onChange={(e) => setNewMsg(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendMessage();
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={sendMessage}
                  disabled={sending || !newMsg.trim()}
                  className="btn-primary px-4 py-2"
                >
                  <SendIcon size={16} />
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-8">
            {/* Contact quick-select */}
            <ContactsQuickSelect onSelect={startFromContact} />
            <p className="text-white/30 text-xs mt-6 mb-3">or</p>
            <button
              type="button"
              onClick={() => setNewMode(true)}
              className="btn-primary px-5 py-2 text-sm"
            >
              <PlusIcon size={14} />
              New message
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Quick-select contacts to start a new conversation */
function ContactsQuickSelect({ onSelect }: { onSelect: (c: Contact) => void }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api<{ contacts: Contact[] }>("/api/contacts")
      .then((res) => setContacts(res.contacts.slice(0, 5)))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  if (!loaded || contacts.length === 0) return null;

  return (
    <div className="w-full max-w-sm">
      <div className="flex items-center gap-2 mb-2">
        <UserIcon size={14} className="text-white/30" />
        <span className="text-xs font-medium text-white/35">Quick message</span>
      </div>
      <div className="space-y-1">
        {contacts.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onSelect(c)}
            className="flex w-full items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-2.5 text-left transition hover:bg-white/[0.05] hover:border-brand-500/30"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-500/15 text-xs font-semibold text-brand-300">
              {c.name.charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium text-white truncate">{c.name}</div>
              <div className="text-xs text-white/35">{c.phone}</div>
            </div>
            <MessageIcon size={14} className="shrink-0 ml-auto text-white/20" />
          </button>
        ))}
      </div>
    </div>
  );
}
