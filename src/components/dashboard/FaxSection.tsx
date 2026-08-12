"use client";

import { useState, useRef, type DragEvent } from "react";
import { api, fmtDate } from "@/lib/client-api";
import { useToast } from "@/components/ToastProvider";
import type { FaxAccount, Fax, PhoneNumber } from "@/lib/types";
import { FaxIcon, PlusIcon, SendIcon, UploadIcon, FileTextIcon, DownloadIcon, EyeIcon, CheckCircleIcon, AlertCircleIcon, XIcon } from "@/components/icons";

interface Props {
  faxAccount: FaxAccount | null;
  faxes: Fax[];
  numbers: PhoneNumber[];
}

export default function FaxSection({ faxAccount, faxes: initialFaxes, numbers }: Props) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const PAGE = 20;

  const [faxes, setFaxes] = useState(initialFaxes);
  const [account, setAccount] = useState<FaxAccount | null>(faxAccount);
  const [loadingAcct, setLoadingAcct] = useState(false);
  const [hasMore, setHasMore] = useState(initialFaxes.length >= PAGE);
  const [loadingMore, setLoadingMore] = useState(false);

  // Send form
  const [showSend, setShowSend] = useState(false);
  const [toNumber, setToNumber] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [scheduledAt, setScheduledAt] = useState("");
  const [didId, setDidId] = useState(numbers[0]?.id ?? "");
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [previewFax, setPreviewFax] = useState<Fax | null>(null);

  const avantfaxUrl = process.env.NEXT_PUBLIC_AVANTFAX_URL ?? "https://voice.innotel.us/fax";
  const IS_DONE = (s: string) => s === "completed" || s === "success" || s === "sent" || s === "received" || s === "scheduled";

  async function setupAccount() {
    setLoadingAcct(true);
    try {
      const res = await api<{ account: FaxAccount }>("/api/fax/account", { method: "POST" });
      setAccount(res.account);
      toast.success("Fax service activated.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to setup");
    } finally { setLoadingAcct(false); }
  }

  function removeFile() { setFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }

  function handleDragOver(e: DragEvent) { e.preventDefault(); setDragOver(true); }
  function handleDragLeave(e: DragEvent) { e.preventDefault(); setDragOver(false); }
  function handleDrop(e: DragEvent) {
    e.preventDefault(); setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) {
      if (f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf")) {
        if (f.size <= 10 * 1024 * 1024) setFile(f); else toast.error("File must be under 10 MB.");
      } else toast.error("Only PDF files accepted.");
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) {
      if (f.size > 10 * 1024 * 1024) { toast.error("File must be under 10 MB."); return; }
      setFile(f);
    }
  }

  async function sendFax() {
    if (!toNumber.trim()) { toast.error("Enter a destination fax number"); return; }
    if (!file && !body.trim()) { toast.error("Attach a PDF or type a body"); return; }
    setSending(true); setProgress(0); setProgressLabel("Preparing...");
    let interval: ReturnType<typeof setInterval> | undefined;
    try {
      interval = setInterval(() => setProgress(p => p >= 85 ? p : Math.min(85, p + (p < 30 ? 15 : p < 60 ? 8 : 4))), 300);
      const t1 = setTimeout(() => setProgressLabel("Uploading..."), 500);
      const t2 = setTimeout(() => setProgressLabel("Sending via HylaFAX+..."), 1500);

      const fd = new FormData();
      fd.set("to_number", toNumber.trim());
      fd.set("from_did_id", didId);
      if (subject) fd.set("subject", subject);
      if (body.trim()) fd.set("body", body.trim());
      if (file) fd.set("file", file);
      if (scheduledAt) fd.set("scheduled_at", scheduledAt);

      const res = await fetch("/api/fax/send", { method: "POST", credentials: "include", body: fd });
      clearTimeout(t1); clearTimeout(t2);
      setProgress(100); setProgressLabel(scheduledAt ? "Scheduled!" : "Sent!");

      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error ?? "Failed"); }
      const data = await res.json() as { fax: Fax; sent: boolean };
      setFaxes(prev => [data.fax, ...prev]);
      toast.success(data.sent ? "Fax sent!" : scheduledAt ? `Scheduled for ${new Date(scheduledAt).toLocaleString()}` : "Fax queued");
      setTimeout(() => { setShowSend(false); resetSendForm(); }, 800);
    } catch (e) {
      setProgress(0); setProgressLabel("Failed");
      toast.error(e instanceof Error ? e.message : "Failed");
      setTimeout(() => setProgressLabel(""), 2000);
    } finally {
      if (interval) clearInterval(interval);
      setSending(false);
    }
  }

  function resetSendForm() { setToNumber(""); setSubject(""); setBody(""); setFile(null); setScheduledAt(""); setProgress(0); setProgressLabel(""); }

  async function loadMore() {
    setLoadingMore(true);
    try {
      const offset = faxes.length;
      const res = await api<{ faxes: Fax[]; hasMore: boolean }>(`/api/fax/send?limit=${PAGE}&offset=${offset}`);
      setFaxes(prev => [...prev, ...res.faxes]);
      setHasMore(res.hasMore);
    } catch { toast.error("Failed to load more"); }
    finally { setLoadingMore(false); }
  }

  const faxNumbers = numbers.filter(n => n.fax_enabled);

  if (!account) {
    return (
      <div className="space-y-6">
        <div><h1 className="text-2xl font-semibold text-white">Fax</h1><p className="mt-1 text-sm text-white/45">Send and receive faxes via AvantFax + HylaFAX+.</p></div>
        <div className="flex flex-col items-center rounded-3xl border border-white/[0.06] bg-white/[0.02] p-12 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-sun-400/15 text-sun-400"><FaxIcon size={30} /></div>
          <h3 className="mt-5 text-lg font-semibold text-white">Set up your fax line</h3>
          <p className="mt-2 max-w-md text-sm text-white/45">Activate fax service on one of your DIDs. Includes AvantFax web access.</p>
          <button type="button" onClick={setupAccount} disabled={loadingAcct} className="btn-primary mt-6 px-6 py-2.5 text-sm flex items-center gap-2">
            {loadingAcct ? "Setting up..." : "Enable fax service"}{!loadingAcct && <PlusIcon size={15} />}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div><h1 className="text-2xl font-semibold text-white">Fax</h1><p className="mt-1 text-sm text-white/45">Send and receive faxes digitally.</p></div>

      {/* Status bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-mint-500/10 bg-mint-500/[0.04] px-6 py-4">
        <div className="flex items-center gap-3">
          <CheckCircleIcon size={20} className="text-mint-400" />
          <div>
            <div className="font-semibold text-white">Fax service active</div>
            <div className="text-sm text-white/40">{account.did ? `DID: ${account.did}` : "Connected to AvantFax"}</div>
          </div>
        </div>
        <button type="button" onClick={() => window.open(
          account.avantfax_username ? `${avantfaxUrl}/client/?user=${encodeURIComponent(account.avantfax_username)}` : avantfaxUrl, "_blank", "noopener,noreferrer"
        )} className="btn-ghost px-4 py-2 text-xs">Open AvantFax</button>
      </div>

      {/* Send form */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">Send a Fax</h2>
          {!showSend && <button type="button" onClick={() => setShowSend(true)} className="btn-primary px-4 py-2 text-sm flex items-center gap-2"><SendIcon size={14} /> New fax</button>}
        </div>

        {showSend && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              {faxNumbers.length > 1 && (
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-white/50">From</span>
                  <select className="w-full rounded-xl border px-4 py-2.5 text-sm outline-none transition focus:border-brand-500/50"
                    style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--foreground)' }}
                    value={didId} onChange={e => setDidId(e.target.value)}>
                    {faxNumbers.map(n => <option key={n.id} value={n.id}>{n.did}</option>)}
                  </select>
                </label>
              )}
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-white/50">To</span>
                <input className="w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:border-brand-500/50 focus:outline-none"
                  placeholder="+1 555 123 4567" value={toNumber} onChange={e => setToNumber(e.target.value)} />
              </label>
              <label className="block space-y-1.5 sm:col-span-2">
                <span className="text-xs font-medium text-white/50">Subject (optional)</span>
                <input className="w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:border-brand-500/50 focus:outline-none"
                  placeholder="Invoice, contract, etc." value={subject} onChange={e => setSubject(e.target.value)} />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-white/50">Schedule (optional)</span>
                <input type="datetime-local" className="w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-sm text-white focus:border-brand-500/50 focus:outline-none"
                  value={scheduledAt} onChange={e => setScheduledAt(e.target.value)} min={new Date().toISOString().slice(0, 16)} />
              </label>
            </div>

            {/* File upload */}
            {!file ? (
              <div onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}
                className={`relative rounded-2xl border-2 border-dashed p-10 text-center transition-colors ${dragOver ? "border-brand-400 bg-brand-400/10" : "border-white/10 bg-white/[0.02]"}`}>
                <input ref={fileInputRef} type="file" accept="application/pdf" onChange={handleFileSelect} className="absolute inset-0 cursor-pointer opacity-0" />
                <UploadIcon size={28} className="mx-auto mb-3 text-white/25" />
                <p className="text-sm text-white/45"><span className="font-medium text-brand-400">Upload a PDF</span> or drag and drop</p>
                <p className="mt-1 text-xs text-white/25">Max 10 MB</p>
              </div>
            ) : (
              <div className="flex items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-3">
                <FileTextIcon size={20} className="text-brand-400" />
                <div className="flex-1 min-w-0"><p className="truncate text-sm font-medium text-white">{file.name}</p><p className="text-xs text-white/35">{(file.size / 1024).toFixed(0)} KB</p></div>
                {!sending && <button type="button" onClick={removeFile} className="rounded-lg p-1.5 text-white/30 hover:bg-white/10 hover:text-white/60"><XIcon size={16} /></button>}
              </div>
            )}

            {!file && (
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-white/50">Or type your fax body</span>
                <textarea className="w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-3 text-sm text-white placeholder:text-white/20 focus:border-brand-500/50 focus:outline-none resize-y min-h-[100px]"
                  placeholder="Dear Sir/Madam,&#10;&#10;Please find attached..." value={body} onChange={e => setBody(e.target.value)} rows={5} />
              </label>
            )}

            {sending && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs"><span className="text-white/45">{progressLabel}</span><span className="text-white/60">{progress}%</span></div>
                <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]"><div className="h-full rounded-full bg-gradient-to-r from-brand-500 to-brand-400 transition-all duration-300 ease-out" style={{ width: `${progress}%` }} /></div>
              </div>
            )}

            <div className="flex gap-3">
              <button type="button" onClick={sendFax} disabled={sending} className="btn-primary px-6 py-2.5 text-sm flex items-center gap-2">
                {sending ? "Sending..." : "Send fax"}{!sending && <SendIcon size={14} />}
              </button>
              {!sending && <button type="button" onClick={() => { setShowSend(false); resetSendForm(); }} className="btn-ghost px-6 py-2.5 text-sm">Cancel</button>}
            </div>
          </div>
        )}
      </div>

      {/* History */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Fax History</h2>
        {faxes.length === 0 ? (
          <div className="rounded-2xl bg-white/[0.02] p-8 text-center"><p className="text-sm text-white/45">No faxes sent or received yet.</p></div>
        ) : (
          <div className="space-y-2">
            {faxes.map(fax => (
              <div key={fax.id} role="button" tabIndex={0} onClick={() => fax.file_path && setPreviewFax(fax)}
                onKeyDown={e => { if (e.key === "Enter" && fax.file_path) setPreviewFax(fax); }}
                className={`flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 ${fax.file_path ? "cursor-pointer hover:bg-white/[0.04] hover:border-white/[0.10] transition-colors" : ""}`}>
                <div className="flex items-center gap-3">
                  {IS_DONE(fax.status) ? <CheckCircleIcon size={18} className="text-mint-400" />
                    : fax.status === "failed" ? <AlertCircleIcon size={18} className="text-rose-500" />
                    : <div className="h-[18px] w-[18px] rounded-full border-2 border-sun-400/50 border-t-transparent animate-spin" />}
                  <div>
                    <div className="text-sm font-medium text-white">
                      {fax.direction === "outbound" ? "To: " : "From: "}{fax.direction === "outbound" ? fax.to_number : (fax.from_number ?? "Unknown")}
                    </div>
                    <div className="text-xs text-white/35">
                      {fax.subject ?? `${fax.pages} page(s)`} · {fmtDate(fax.created_at)}
                      {fax.status === "scheduled" && fax.scheduled_at && <span className="ml-1 text-brand-300">→ {new Date(fax.scheduled_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${IS_DONE(fax.status) ? "bg-mint-500/10 text-mint-400" : fax.status === "failed" ? "bg-rose-500/10 text-rose-300" : "bg-sun-400/10 text-sun-400"}`}>{fax.status}</span>
                  {fax.file_path && <>
                    <button type="button" onClick={e => { e.stopPropagation(); setPreviewFax(fax); }} className="text-white/30 hover:text-white/60" title="Preview"><EyeIcon size={14} /></button>
                    <a href={`/api/fax/download?id=${encodeURIComponent(fax.id)}`} download onClick={e => e.stopPropagation()} className="text-white/30 hover:text-white/60" title="Download"><DownloadIcon size={14} /></a>
                  </>}
                </div>
              </div>
            ))}
          </div>
        )}
        {faxes.length > 0 && (
          <div className="mt-4 flex items-center justify-between">
            <p className="text-xs text-white/30">Showing {faxes.length} fax{hasMore ? "" : " total"}</p>
            {hasMore && <button type="button" onClick={loadMore} disabled={loadingMore} className="btn-ghost px-4 py-2 text-xs">{loadingMore ? "Loading..." : `Load ${PAGE} more`}</button>}
          </div>
        )}
      </div>

      {/* Preview modal */}
      {previewFax && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={() => setPreviewFax(null)}>
          <div className="relative z-10 flex max-h-[90vh] w-full max-w-3xl flex-col rounded-3xl border border-white/[0.08] bg-[#0d0d1a] shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-4 border-b border-white/[0.06] px-6 py-4">
              <div className="min-w-0">
                <h3 className="truncate text-base font-semibold text-white">{previewFax.subject ?? `Fax · ${previewFax.pages} page(s)`}</h3>
                <p className="mt-0.5 text-xs text-white/40">
                  {previewFax.direction === "outbound" ? "To: " : "From: "}{previewFax.direction === "outbound" ? previewFax.to_number : (previewFax.from_number ?? "Unknown")}
                  {" · "}{previewFax.pages} page{previewFax.pages !== 1 ? "s" : ""}{" · "}{fmtDate(previewFax.created_at)}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <a href={`/api/fax/download?id=${encodeURIComponent(previewFax.id)}`} download className="btn-ghost px-4 py-2 text-xs flex items-center gap-1.5"><DownloadIcon size={14} /> Download</a>
                <button type="button" onClick={() => setPreviewFax(null)} className="rounded-lg p-1.5 text-white/30 hover:text-white/60"><XIcon size={20} /></button>
              </div>
            </div>
            <div className="p-4">
              <iframe src={`/api/fax/download?id=${encodeURIComponent(previewFax.id)}`} className="w-full rounded-xl bg-white" style={{ height: "70vh" }} title="Fax preview" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
