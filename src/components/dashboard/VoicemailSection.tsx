"use client";

import { useState, useRef } from "react";
import { api, fmtDate, fmtDuration } from "@/lib/client-api";
import { VoicemailIcon, PlayIcon, MailIcon, PauseIcon } from "@/components/icons";
import type { Voicemail } from "@/lib/types";

interface Props {
  voicemails: Voicemail[];
}

export default function VoicemailClient({ voicemails: initialVoicemails }: Props) {
  const [voicemails, setVoicemails] = useState<Voicemail[]>(initialVoicemails);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [emailingId, setEmailingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  function togglePlay(vm: Voicemail) {
    // Stop current audio if any
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }

    if (playingId === vm.id) {
      setPlayingId(null);
      return;
    }

    const audioUrl = `/api/voicemail/audio?id=${vm.id}`;
    const audio = new Audio(audioUrl);
    audioRef.current = audio;

    audio.onended = () => {
      setPlayingId(null);
      audioRef.current = null;
      // Persist listened state
      if (vm.listened === 0) {
        setVoicemails((prev) =>
          prev.map((v) => (v.id === vm.id ? { ...v, listened: 1 } : v)),
        );
        api("/api/voicemail/listened", {
          method: "POST",
          body: JSON.stringify({ voicemail_id: vm.id }),
        }).catch(() => {});
      }
    };

    audio.onerror = () => {
      setError("Failed to play voicemail audio");
      setPlayingId(null);
      audioRef.current = null;
    };

    audio.play();
    setPlayingId(vm.id);
  }

  async function handleEmail(vm: Voicemail) {
    setEmailingId(vm.id);
    setError(null);
    setMessage(null);
    try {
      await api("/api/voicemail/email", {
        method: "POST",
        body: JSON.stringify({ voicemail_id: vm.id }),
      });
      setMessage(`Voicemail forwarded to your email.`);
      setTimeout(() => setMessage(null), 3000);
      setEmailingId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to email voicemail");
      setEmailingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">Voicemail</h1>
        <p className="mt-1 text-sm text-white/45">
          Listen to your voicemails with transcriptions.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          {error}
        </div>
      )}
      {message && (
        <div className="rounded-xl border border-mint-500/30 bg-mint-500/10 px-4 py-3 text-sm text-mint-300">
          {message}
        </div>
      )}

      {voicemails.length === 0 ? (
        <div className="card-surface flex flex-col items-center rounded-3xl p-10 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-brand-500/15 text-brand-300">
            <VoicemailIcon size={30} />
          </div>
          <h3 className="mt-5 text-lg font-semibold text-white">No voicemails</h3>
          <p className="mt-2 max-w-md text-sm text-white/45">
            You don&apos;t have any voicemails yet. Voicemails will appear here
            when someone leaves a message on your extension.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {voicemails.map((vm) => (
            <div
              key={vm.id}
              className={`card-surface rounded-2xl p-5 transition ${
                vm.listened === 0 ? "border-brand-500/30" : ""
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-4 min-w-0">
                  <div className={`shrink-0 mt-1 flex h-10 w-10 items-center justify-center rounded-full ${
                    vm.listened === 0 ? "bg-brand-500/15" : "bg-white/[0.05]"
                  }`}>
                    <VoicemailIcon size={18} className={vm.listened === 0 ? "text-brand-300" : "text-white/35"} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-white truncate">
                        {vm.caller_name ?? vm.caller_id ?? "Unknown caller"}
                      </h3>
                      {vm.listened === 0 && (
                        <span className="shrink-0 rounded-full bg-brand-500 px-2 py-0.5 text-[10px] font-semibold text-white">
                          New
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-white/35 mt-0.5">
                      {vm.caller_id && <span>{vm.caller_id} · </span>}
                      {fmtDuration(vm.duration_seconds)} · {fmtDate(vm.created_at)}
                    </p>
                    {vm.transcript && (
                      <p className="mt-2 text-sm text-white/65 line-clamp-2 italic">
                        &ldquo;{vm.transcript}&rdquo;
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => togglePlay(vm)}
                    className={`rounded-lg border p-2 transition ${
                      playingId === vm.id
                        ? "border-brand-500/50 bg-brand-500/10 text-brand-300"
                        : "border-white/[0.08] bg-white/[0.03] text-white/50 hover:text-white"
                    }`}
                    title={playingId === vm.id ? "Stop" : "Play"}
                  >
                    {playingId === vm.id ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleEmail(vm)}
                    disabled={emailingId === vm.id}
                    className={`rounded-lg border p-2 transition ${
                      emailingId === vm.id
                        ? "border-mint-500/50 bg-mint-500/10 text-mint-400"
                        : "border-white/[0.08] bg-white/[0.03] text-white/50 hover:text-white"
                    }`}
                    title="Email to me"
                  >
                    <MailIcon size={16} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
