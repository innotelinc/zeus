"use client";

import { useState } from "react";
import { api, fmtDate } from "@/lib/client-api";
import { useToast } from "@/components/ToastProvider";
import type { FaxAccount, Fax, PhoneNumber } from "@/lib/types";
import {
  FaxIcon,
  PlusIcon,
  SendIcon,
  DownloadIcon,
  CheckCircleIcon,
  AlertCircleIcon,
} from "@/components/icons";

interface Props {
  faxAccount: FaxAccount | null;
  faxes: Fax[];
  numbers: PhoneNumber[];
}

export default function FaxSection({ faxAccount, faxes: initialFaxes, numbers }: Props) {
  const { toast } = useToast();
  const [faxes, setFaxes] = useState<Fax[]>(initialFaxes);
  const [account, setAccount] = useState<FaxAccount | null>(faxAccount);
  const [loading, setLoading] = useState(false);

  const [sendMode, setSendMode] = useState(false);
  const [toNumber, setToNumber] = useState("");
  const [subject, setSubject] = useState("");
  const [selectedDidId, setSelectedDidId] = useState(numbers[0]?.id ?? "");
  const [sending, setSending] = useState(false);

  const avantfaxUrl = process.env.NEXT_PUBLIC_AVANTFAX_URL ?? "https://voice.innotel.us/avantfax";

  async function setupFaxAccount() {
    setLoading(true);
    try {
      const res = await api<{ account: FaxAccount }>("/api/fax/account", {
        method: "POST",
      });
      setAccount(res.account);
      toast.success("Fax service activated.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to setup fax account");
    } finally {
      setLoading(false);
    }
  }

  async function sendFax() {
    if (!toNumber.trim()) {
      toast.error("Please enter a destination fax number");
      return;
    }
    setSending(true);
    try {
      const res = await api<{ fax: Fax }>("/api/fax/send", {
        method: "POST",
        body: JSON.stringify({
          to_number: toNumber.trim(),
          from_did_id: selectedDidId,
          subject: subject || undefined,
        }),
      });
      setFaxes((prev) => [res.fax, ...prev]);
      setSendMode(false);
      setToNumber("");
      setSubject("");
      toast.success("Fax queued for sending.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to send fax");
    } finally {
      setSending(false);
    }
  }

  const faxEnabledNumbers = numbers.filter((n) => n.fax_enabled);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">Fax</h1>
        <p className="mt-1 text-sm text-white/45">
          Send and receive faxes digitally. Powered by AvantFax.
        </p>
      </div>

      {!account ? (
        <div className="card-surface flex flex-col items-center rounded-3xl p-10 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-sun-400/15 text-sun-400">
            <FaxIcon size={30} />
          </div>
          <h3 className="mt-5 text-lg font-semibold text-white">Set up your fax line</h3>
          <p className="mt-2 max-w-md text-sm text-white/45">
            Activate fax service on one of your DIDs to start sending and receiving faxes.
            Includes AvantFax web access for full fax management.
          </p>
          <button
            type="button"
            onClick={setupFaxAccount}
            disabled={loading}
            className="btn-primary mt-6 px-6 py-2.5 text-sm"
          >
            {loading ? "Setting up..." : "Enable fax service"}
            {!loading && <PlusIcon size={15} />}
          </button>
        </div>
      ) : (
        <>
          <div className="card-surface rounded-2xl p-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <CheckCircleIcon size={20} className="text-mint-400" />
                <div>
                  <div className="font-semibold text-white">Fax service active</div>
                  <div className="text-sm text-white/40">
                    {account.did ? `DID: ${account.did}` : "Connected to AvantFax"}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  const url = account.avantfax_username
                    ? `${avantfaxUrl}/client/?user=${encodeURIComponent(account.avantfax_username)}`
                    : avantfaxUrl;
                  window.open(url, "_blank", "noopener,noreferrer");
                }}
                className="btn-ghost px-4 py-2 text-xs"
              >
                Open AvantFax
              </button>
            </div>
          </div>

          <div className="card-surface rounded-2xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-white">Send a Fax</h2>
              {!sendMode && (
                <button
                  type="button"
                  onClick={() => setSendMode(true)}
                  className="btn-primary px-4 py-2 text-sm"
                >
                  <SendIcon size={14} />
                  New fax
                </button>
              )}
            </div>

            {sendMode && (
              <div className="space-y-4 animate-slide-up">
                <div className="grid gap-4 sm:grid-cols-2">
                  {faxEnabledNumbers.length > 1 && (
                    <label className="block">
                      <span className="input-label">From (DID)</span>
                      <select className="input-base" value={selectedDidId} onChange={(e) => setSelectedDidId(e.target.value)}>
                        {faxEnabledNumbers.map((n) => (
                          <option key={n.id} value={n.id}>{n.did}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="block">
                    <span className="input-label">To (fax number)</span>
                    <input className="input-base" placeholder="+1 555 123 4567" value={toNumber} onChange={(e) => setToNumber(e.target.value)} />
                  </label>
                  <label className="block sm:col-span-2">
                    <span className="input-label">Subject (optional)</span>
                    <input className="input-base" placeholder="Fax subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
                  </label>
                </div>
                <p className="text-xs text-white/35">
                  Upload a PDF via the AvantFax web interface to attach files. This will queue a fax via HylaFAX+.
                </p>
                <div className="flex gap-3">
                  <button type="button" onClick={sendFax} disabled={sending} className="btn-primary px-6 py-2.5 text-sm">
                    {sending ? "Sending..." : "Send fax"}
                  </button>
                  <button type="button" onClick={() => setSendMode(false)} className="btn-ghost px-6 py-2.5 text-sm">
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="card-surface rounded-2xl p-6">
            <h2 className="text-lg font-semibold text-white mb-4">Fax History</h2>
            {faxes.length === 0 ? (
              <div className="rounded-2xl bg-white/[0.02] p-8 text-center">
                <p className="text-sm text-white/45">No faxes sent or received yet.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {faxes.map((fax) => (
                  <div key={fax.id} className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                    <div className="flex items-center gap-3">
                      {fax.status === "completed" || fax.status === "success" ? (
                        <CheckCircleIcon size={18} className="text-mint-400" />
                      ) : fax.status === "failed" ? (
                        <AlertCircleIcon size={18} className="text-rose-500" />
                      ) : (
                        <div className="h-[18px] w-[18px] rounded-full border-2 border-sun-400/50 border-t-transparent animate-spin" />
                      )}
                      <div>
                        <div className="text-sm font-medium text-white">
                          {fax.direction === "outbound" ? "To: " : "From: "}
                          {fax.direction === "outbound" ? fax.to_number : (fax.from_number ?? "Unknown")}
                        </div>
                        <div className="text-xs text-white/35">
                          {fax.subject ?? `Fax · ${fax.pages} page(s)`} · {fmtDate(fax.created_at)}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        fax.status === "completed" || fax.status === "success"
                          ? "bg-mint-500/10 text-mint-400"
                          : fax.status === "failed"
                            ? "bg-rose-500/10 text-rose-300"
                            : "bg-sun-400/10 text-sun-400"
                      }`}>
                        {fax.status}
                      </span>
                      {fax.file_path && (
                        <DownloadIcon size={14} className="text-white/30 cursor-pointer hover:text-white/60" />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
