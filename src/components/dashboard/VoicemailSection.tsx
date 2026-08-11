"use client";

import { useState, useRef } from "react";
import { api, fmtDate, fmtDuration } from "@/lib/client-api";
import { VoicemailIcon, PlayIcon, MailIcon, PauseIcon } from "@/components/icons";
import { useToast } from "@/components/ToastProvider";
import type { Voicemail } from "@/lib/types";

interface Props {
  voicemails: Voicemail[];
}

export default function VoicemailSection({ voicemails: initial }: Props) {
  const { toast } = useToast();
  const [voicemails, setVoicemails] = useState(initial);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [emailingId, setEmailingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  function togglePlay(vm: Voicemail) {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    if (playingId === vm.id) { setPlayingId(null); return; }

    const audio = new Audio(`/api/voicemail/audio?id=${vm.id}`);
    audioRef.current = audio;
    audio.onended = () => {
      setPlayingId(null); audioRef.current = null;
      if (vm.listened === 0) {
        setVoicemails(prev => prev.map(v => v.id === vm.id ? { ...v, listened: 1 } : v));
        api("/api/voicemail/listened", { method: "POST", body: JSON.stringify({ voicemail_id: vm.id }) }).catch(() => {});
      }
    };
    audio.onerror = () => { toast.error("Failed to play audio"); setPlayingId(null); audioRef.current = null; };
    audio.play();
    setPlayingId(vm.id);
  }

  async function handleEmail(vm: Voicemail) {
    setEmailingId(vm.id);
    try {
      await api("/api/voicemail/email", { method: "POST", body: JSON.stringify({ voicemail_id: vm.id }) });
      toast.success("Voicemail forwarded to your email.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to email");
    } finally { setEmailingId(null); }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">Voicemail</h1>
        <p className="mt-1 text-sm text-white/45">Listen to your voicemails with transcriptions.</p>
      </div>

      {voicemails.length === 0 ? (
        <div className="flex flex-col items-center rounded-3xl border border-white/[0.06] bg-white/[0.02] p-12 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-500/15 text-brand-300"><VoicemailIcon size={30} /></div>
          <h3 className="mt-5 text-lg font-semibold text-white">No voicemails</h3>
          <p className="mt-2 max-w-md text-sm text-white/45">You don't have any voicemails yet. Voicemails will appear here when someone leaves a message on your extension.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {voicemails.map(vm => (
            <div key={vm.id} className={`rounded-2xl border p-5 transition-colors ${vm.listened === 0 ? "border-brand-500/20 bg-brand-500/[0.03]" : "border-white/[0.06] bg-white/[0.02]"}`}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-4 min-w-0">
                  <div className={`shrink-0 mt-1 flex h-10 w-10 items-center justify-center rounded-full ${vm.listened === 0 ? "bg-brand-500/15" : "bg-white/[0.05]"}`}>
                    <VoicemailIcon size={18} className={vm.listened === 0 ? "text-brand-300" : "text-white/35"} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-white truncate">{vm.caller_name ?? vm.caller_id ?? "Unknown caller"}</h3>
                      {vm.listened === 0 && <span className="shrink-0 rounded-full bg-brand-500 px-2 py-0.5 text-[10px] font-semibold text-white">New</span>}
                    </div>
                    <p className="text-xs text-white/35 mt-0.5">
                      {vm.caller_id && <span>{vm.caller_id} · </span>}{fmtDuration(vm.duration_seconds)} · {fmtDate(vm.created_at)}
                    </p>
                    {vm.transcript && (
                      <p className="mt-2 text-sm text-white/60 line-clamp-2 italic">"{vm.transcript}"</p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button type="button" onClick={() => togglePlay(vm)}
                    className={`rounded-lg border p-2 transition ${playingId === vm.id ? "border-brand-500/50 bg-brand-500/10 text-brand-300" : "border-white/[0.08] bg-white/[0.03] text-white/50 hover:text-white"}`}
                    title={playingId === vm.id ? "Stop" : "Play"}>
                    {playingId === vm.id ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
                  </button>
                  <button type="button" onClick={() => handleEmail(vm)} disabled={emailingId === vm.id}
                    className={`rounded-lg border p-2 transition ${emailingId === vm.id ? "border-mint-500/50 bg-mint-500/10 text-mint-400" : "border-white/[0.08] bg-white/[0.03] text-white/50 hover:text-white"}`}
                    title="Email to me">
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
