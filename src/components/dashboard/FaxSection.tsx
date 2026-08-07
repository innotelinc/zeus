"use client";

import { useState, useRef, type DragEvent } from "react";
import { api, fmtDate } from "@/lib/client-api";
import { useToast } from "@/components/ToastProvider";
import type { FaxAccount, Fax, PhoneNumber } from "@/lib/types";
import {
  FaxIcon,
  PlusIcon,
  SendIcon,
  UploadIcon,
  FileTextIcon,
  DownloadIcon,
  CheckCircleIcon,
  AlertCircleIcon,
  XIcon,
} from "@/components/icons";

interface Props {
  faxAccount: FaxAccount | null;
  faxes: Fax[];
  numbers: PhoneNumber[];
}

export default function FaxSection({ faxAccount, faxes: initialFaxes, numbers }: Props) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [faxes, setFaxes] = useState<Fax[]>(initialFaxes);
  const [account, setAccount] = useState<FaxAccount | null>(faxAccount);
  const [loading, setLoading] = useState(false);

  const [sendMode, setSendMode] = useState(false);
  const [toNumber, setToNumber] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [selectedDidId, setSelectedDidId] = useState(numbers[0]?.id ?? "");
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const avantfaxUrl =
    process.env.NEXT_PUBLIC_AVANTFAX_URL ?? "https://voice.innotel.us/fax";

  const IS_DONE = (s: string) =>
    s === "completed" || s === "success" || s === "sent" || s === "received";

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

  function removeFile() {
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    setDragOver(true);
  }
  function handleDragLeave(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
  }
  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile) {
      if (
        droppedFile.type === "application/pdf" ||
        droppedFile.name.toLowerCase().endsWith(".pdf")
      ) {
        if (droppedFile.size <= 10 * 1024 * 1024) {
          setFile(droppedFile);
        } else {
          toast.error("File must be under 10 MB.");
        }
      } else {
        toast.error("Only PDF files are accepted.");
      }
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (selected) {
      if (selected.size > 10 * 1024 * 1024) {
        toast.error("File must be under 10 MB.");
        return;
      }
      setFile(selected);
    }
  }

  async function sendFax() {
    if (!toNumber.trim()) {
      toast.error("Please enter a destination fax number");
      return;
    }
    if (!file && !body.trim()) {
      toast.error("Attach a PDF or type a fax body");
      return;
    }

    setSending(true);
    setProgress(0);
    setProgressLabel("Preparing fax...");

    // Interval ref scoped outside try so finally can clear it
    let progressInterval: ReturnType<typeof setInterval> | undefined;

    try {
      progressInterval = setInterval(() => {
        setProgress((prev) => {
          if (prev >= 85) return prev;
          const inc = prev < 30 ? 15 : prev < 60 ? 8 : 4;
          return Math.min(85, prev + inc);
        });
      }, 300);

      const tm1 = setTimeout(() => setProgressLabel("Uploading..."), 500);
      const tm2 = setTimeout(() => setProgressLabel("Sending via HylaFAX+..."), 1500);

      const formData = new FormData();
      formData.set("to_number", toNumber.trim());
      formData.set("from_did_id", selectedDidId);
      if (subject) formData.set("subject", subject);
      if (body.trim()) formData.set("body", body.trim());
      if (file) formData.set("file", file);

      const res = await fetch("/api/fax/send", {
        method: "POST",
        body: formData,
      });

      clearTimeout(tm1);
      clearTimeout(tm2);
      setProgress(100);
      setProgressLabel("Sent!");

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to send fax");
      }

      const data = (await res.json()) as { fax: Fax; sent: boolean };
      setFaxes((prev) => [data.fax, ...prev]);
      toast.success(data.sent ? "Fax sent!" : "Fax queued for delivery");

      // Reset after a moment
      setTimeout(() => {
        setSendMode(false);
        setToNumber("");
        setSubject("");
        setBody("");
        setFile(null);
        setProgress(0);
        setProgressLabel("");
      }, 800);
    } catch (e) {
      setProgress(0);
      setProgressLabel("Failed");
      toast.error(e instanceof Error ? e.message : "Failed to send fax");
      // Show failure briefly then reset
      setTimeout(() => setProgressLabel(""), 2000);
    } finally {
      if (progressInterval) clearInterval(progressInterval);
      setSending(false);
    }
  }

  const faxEnabledNumbers = numbers.filter((n) => n.fax_enabled);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">Fax</h1>
        <p className="mt-1 text-sm text-white/45">
          Send and receive faxes digitally. Powered by AvantFax + HylaFAX+.
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
                      <select
                        className="input-base"
                        value={selectedDidId}
                        onChange={(e) => setSelectedDidId(e.target.value)}
                      >
                        {faxEnabledNumbers.map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.did}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="block">
                    <span className="input-label">To (fax number)</span>
                    <input
                      className="input-base"
                      placeholder="+1 555 123 4567"
                      value={toNumber}
                      onChange={(e) => setToNumber(e.target.value)}
                    />
                  </label>
                  <label className="block sm:col-span-2">
                    <span className="input-label">Subject (optional)</span>
                    <input
                      className="input-base"
                      placeholder="Invoice, contract, etc."
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                    />
                  </label>
                </div>

                {/* ── File upload area ──────────────────────── */}
                {!file ? (
                  <div
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    className={`relative rounded-2xl border-2 border-dashed p-8 text-center transition-colors ${
                      dragOver
                        ? "border-brand-400 bg-brand-400/10"
                        : "border-white/10 bg-white/[0.02]"
                    }`}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="application/pdf"
                      onChange={handleFileSelect}
                      className="absolute inset-0 cursor-pointer opacity-0"
                    />
                    <UploadIcon size={28} className="mx-auto mb-3 text-white/25" />
                    <p className="text-sm text-white/45">
                      <span className="font-medium text-brand-400">
                        Upload a PDF
                      </span>{" "}
                      or drag and drop
                    </p>
                    <p className="mt-1 text-xs text-white/25">Max 10 MB</p>
                  </div>
                ) : (
                  <div className="flex items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-3">
                    <FileTextIcon size={20} className="text-brand-400" />
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-sm font-medium text-white">
                        {file.name}
                      </p>
                      <p className="text-xs text-white/35">
                        {(file.size / 1024).toFixed(0)} KB
                      </p>
                    </div>
                    {!sending && (
                      <button
                        type="button"
                        onClick={removeFile}
                        className="rounded-lg p-1.5 text-white/30 hover:bg-white/10 hover:text-white/60 transition-colors"
                      >
                        <XIcon size={16} />
                      </button>
                    )}
                  </div>
                )}

                {/* ── Text body ─────────────────────────────── */}
                {!file && (
                  <label className="block">
                    <span className="input-label">
                      Or type your fax body
                    </span>
                    <textarea
                      className="input-base min-h-[120px] resize-y"
                      placeholder="Dear Sir/Madam,&#10;&#10;Please find attached...&#10;&#10;Sincerely,"
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      rows={5}
                    />
                  </label>
                )}

                {/* ── Progress bar ──────────────────────────── */}
                {sending && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-white/45">{progressLabel}</span>
                      <span className="text-white/60">{progress}%</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-brand-500 to-brand-400 transition-all duration-300 ease-out"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  </div>
                )}

                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={sendFax}
                    disabled={sending}
                    className="btn-primary px-6 py-2.5 text-sm"
                  >
                    {sending ? "Sending..." : "Send fax"}
                    {!sending && <SendIcon size={14} />}
                  </button>
                  {!sending && (
                    <button
                      type="button"
                      onClick={() => {
                        setSendMode(false);
                        setFile(null);
                        setBody("");
                        setToNumber("");
                        setSubject("");
                      }}
                      className="btn-ghost px-6 py-2.5 text-sm"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="card-surface rounded-2xl p-6">
            <h2 className="text-lg font-semibold text-white mb-4">Fax History</h2>
            {faxes.length === 0 ? (
              <div className="rounded-2xl bg-white/[0.02] p-8 text-center">
                <p className="text-sm text-white/45">
                  No faxes sent or received yet.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {faxes.map((fax) => (
                  <div
                    key={fax.id}
                    className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3"
                  >
                    <div className="flex items-center gap-3">
                      {IS_DONE(fax.status) ? (
                        <CheckCircleIcon size={18} className="text-mint-400" />
                      ) : fax.status === "failed" ? (
                        <AlertCircleIcon size={18} className="text-rose-500" />
                      ) : (
                        <div className="h-[18px] w-[18px] rounded-full border-2 border-sun-400/50 border-t-transparent animate-spin" />
                      )}
                      <div>
                        <div className="text-sm font-medium text-white">
                          {fax.direction === "outbound" ? "To: " : "From: "}
                          {fax.direction === "outbound"
                            ? fax.to_number
                            : (fax.from_number ?? "Unknown")}
                        </div>
                        <div className="text-xs text-white/35">
                          {fax.subject ?? `Fax · ${fax.pages} page(s)`} ·{" "}
                          {fmtDate(fax.created_at)}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          IS_DONE(fax.status)
                            ? "bg-mint-500/10 text-mint-400"
                            : fax.status === "failed"
                              ? "bg-rose-500/10 text-rose-300"
                              : "bg-sun-400/10 text-sun-400"
                        }`}
                      >
                        {fax.status}
                      </span>
                      {fax.file_path && (
                        <a
                          href={`/api/fax/download?id=${encodeURIComponent(fax.id)}`}
                          download
                          className="text-white/30 hover:text-white/60 transition-colors"
                          title="Download fax"
                        >
                          <DownloadIcon size={14} />
                        </a>
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
