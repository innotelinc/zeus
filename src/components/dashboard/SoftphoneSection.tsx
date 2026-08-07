"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { UserAgent, Registerer, Inviter, SessionState } from "sip.js";
import type { FreePBXExtension } from "@/lib/types";
import { PhoneIcon } from "@/components/icons";
import { useToast } from "@/components/ToastProvider";

interface Props {
  extensions: FreePBXExtension[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SipSession = any;

type CallState = "disconnected" | "registering" | "idle" | "dialing" | "ringing-out" | "ringing-in" | "in-call" | "held";

interface ActiveCall {
  session: SipSession;
  remoteId: string;
  direction: "inbound" | "outbound";
  startTime: number;
  muted: boolean;
}

export default function SoftphoneSection({ extensions }: Props) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [callState, setCallState] = useState<CallState>("disconnected");
  const [selectedExtId, setSelectedExtId] = useState("");
  const [dialNumber, setDialNumber] = useState("");
  const [incomingCaller, setIncomingCaller] = useState("");
  const [callDuration, setCallDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [showDtmf, setShowDtmf] = useState(false);

  const userAgentRef = useRef<UserAgent | null>(null);
  const registererRef = useRef<Registerer | null>(null);
  const activeCallRef = useRef<ActiveCall | null>(null);
  const pendingInvitationRef = useRef<SipSession | null>(null);
  const autoRejectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const stateListenerRefs = useRef<Array<{ remove: () => void }>>([]);

  const selectedExt = extensions.find((e) => e.id === selectedExtId);

  const wssUrl = useMemo(() => {
    if (typeof window === "undefined") return "wss://localhost:8089/ws";
    return (
      process.env.NEXT_PUBLIC_FREEPBX_WSS_URL ??
      `wss://${window.location.hostname}:8089/ws`
    );
  }, []);

  const iceServers = useMemo(() => {
    const servers: RTCIceServer[] = [
      { urls: "stun:stun.l.google.com:19302" },
    ];
    const turnUrl = process.env.NEXT_PUBLIC_TURN_SERVER;
    const turnUser = process.env.NEXT_PUBLIC_TURN_USERNAME;
    const turnCred = process.env.NEXT_PUBLIC_TURN_CREDENTIAL;
    if (turnUrl) {
      servers.push({
        urls: turnUrl,
        username: turnUser,
        credential: turnCred,
      });
    }
    return servers;
  }, []);

  useEffect(() => {
    return () => {
      cleanupAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function cleanupAll() {
    if (autoRejectTimerRef.current) {
      clearTimeout(autoRejectTimerRef.current);
      autoRejectTimerRef.current = null;
    }
    if (callTimerRef.current) {
      clearInterval(callTimerRef.current);
      callTimerRef.current = null;
    }
    stateListenerRefs.current.forEach((s) => s.remove());
    stateListenerRefs.current = [];
    pendingInvitationRef.current = null;
    registererRef.current?.unregister().catch(() => {});
    userAgentRef.current?.stop();
    userAgentRef.current = null;
    registererRef.current = null;
    activeCallRef.current = null;
  }

  async function connectExtension() {
    if (!selectedExt) return;
    setCallState("registering");

    cleanupAll();

    try {
      const extNumber = selectedExt.extension_id;
      const password = selectedExt.extension_secret ?? "";
      const domain = new URL(wssUrl).hostname;

      const userAgent = new UserAgent({
        uri: UserAgent.makeURI(`sip:${extNumber}@${domain}`),
        transportOptions: {
          server: wssUrl,
        },
        authorizationUsername: extNumber,
        authorizationPassword: password,
        sessionDescriptionHandlerFactoryOptions: {
          peerConnectionConfiguration: {
            iceServers,
          },
        },
        allowLegacyNotifications: true,
      });

      userAgent.delegate = {
        onInvite: (invitation) => {
          const remoteId = invitation.remoteIdentity.uri.user ?? "Unknown";
          setIncomingCaller(remoteId);
          setCallState("ringing-in");
          pendingInvitationRef.current = invitation;

          autoRejectTimerRef.current = setTimeout(() => {
            if (pendingInvitationRef.current === invitation) {
              invitation.reject();
              setCallState("idle");
              setIncomingCaller("");
              pendingInvitationRef.current = null;
            }
          }, 60_000);

          const sub = invitation.stateChange;
          sub.addListener((state: SessionState) => {
            if (state === SessionState.Terminated) {
              if (autoRejectTimerRef.current) {
                clearTimeout(autoRejectTimerRef.current);
                autoRejectTimerRef.current = null;
              }
              endCallToIdle();
              pendingInvitationRef.current = null;
            }
          });
        },
      };

      userAgent.transport.stateChange.addListener((state) => {
        if (state === "Disconnected") {
          toast.error("Connection lost. Please reconnect.");
          setCallState("disconnected");
        }
      });

      await userAgent.start();

      const registerer = new Registerer(userAgent);
      await registerer.register();

      userAgentRef.current = userAgent;
      registererRef.current = registerer;
      setCallState("idle");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to connect extension");
      setCallState("disconnected");
    }
  }

  function disconnect() {
    cleanupAll();
    setCallState("disconnected");
    setSelectedExtId("");
    setDialNumber("");
    setIncomingCaller("");
  }

  function appendDigit(d: string) {
    if (callState !== "idle" && callState !== "dialing") return;
    setCallState("dialing");
    setDialNumber((prev) => prev + d);
  }

  function clearDial() {
    setDialNumber("");
    if (callState === "dialing") setCallState("idle");
  }

  function backspaceDial() {
    setDialNumber((prev) => prev.slice(0, -1));
    if (dialNumber.length <= 1 && callState === "dialing") setCallState("idle");
  }

  async function makeCall() {
    const userAgent = userAgentRef.current;
    if (!userAgent || !dialNumber.trim()) return;

    setCallState("ringing-out");
    const targetNumber = dialNumber.trim();

    try {
      const domain = new URL(wssUrl).hostname;
      const uri = UserAgent.makeURI(`sip:${targetNumber}@${domain}`);
      if (!uri) {
        toast.error("Invalid phone number");
        setCallState("idle");
        return;
      }

      const inviter = new Inviter(userAgent, uri, {
        sessionDescriptionHandlerOptions: {
          constraints: { audio: true, video: false },
        },
      });

      const session: SipSession = inviter;
      const sub = inviter.stateChange;
      sub.addListener((state: SessionState) => {
        if (state === SessionState.Established) {
          setCallState("in-call");
          startCallTimer(session, "outbound");
          attachMedia(session);
        } else if (state === SessionState.Terminated) {
          endCallToIdle();
        }
      });

      await inviter.invite();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Call failed");
      setCallState("idle");
    }
  }

  async function answerCall() {
    const invitation = pendingInvitationRef.current;
    if (!invitation) return;

    setCallState("in-call");
    setIncomingCaller("");

    if (autoRejectTimerRef.current) {
      clearTimeout(autoRejectTimerRef.current);
      autoRejectTimerRef.current = null;
    }

    try {
      const sub = invitation.stateChange;
      sub.addListener((state: SessionState) => {
        if (state === SessionState.Established) {
          attachMedia(invitation);
          startCallTimer(invitation, "inbound");
        } else if (state === SessionState.Terminated) {
          endCallToIdle();
        }
      });

      await invitation.accept({
        sessionDescriptionHandlerOptions: {
          constraints: { audio: true, video: false },
        },
      });
      pendingInvitationRef.current = null;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to answer call");
      setCallState("idle");
      pendingInvitationRef.current = null;
    }
  }

  function rejectCall() {
    const invitation = pendingInvitationRef.current;
    if (invitation) invitation.reject();
    setCallState("idle");
    setIncomingCaller("");
    pendingInvitationRef.current = null;
    if (autoRejectTimerRef.current) {
      clearTimeout(autoRejectTimerRef.current);
      autoRejectTimerRef.current = null;
    }
  }

  function hangup() {
    const call = activeCallRef.current;
    if (call?.session) {
      try {
        call.session.bye?.();
      } catch {
        // ignore
      }
    }
    endCallToIdle();
  }

  function sendDtmf(digit: string) {
    const call = activeCallRef.current;
    if (!call?.session || callState !== "in-call") return;
    try {
      call.session.dtmf?.(digit);
    } catch {
      // ignore
    }
  }

  function toggleMute() {
    const call = activeCallRef.current;
    if (!call) return;
    const muted = !call.muted;
    try {
      const pc = call.session?.sessionDescriptionHandler?.peerConnection as RTCPeerConnection | undefined;
      if (pc) {
        pc.getSenders().forEach((sender: RTCRtpSender) => {
          if (sender.track?.kind === "audio") {
            sender.track.enabled = !muted;
          }
        });
      }
    } catch {
      // ignore
    }
    activeCallRef.current = { ...call, muted };
  }

  function toggleHold() {
    const call = activeCallRef.current;
    if (!call) return;

    if (callState === "in-call") {
      setCallState("held");
      try {
        call.session.hold?.();
      } catch {
        // ignore
      }
    } else if (callState === "held") {
      setCallState("in-call");
      try {
        call.session.unhold?.();
      } catch {
        // ignore
      }
    }
  }

  function endCallToIdle() {
    if (callTimerRef.current) {
      clearInterval(callTimerRef.current);
      callTimerRef.current = null;
    }
    setCallDuration(0);
    activeCallRef.current = null;
    setDialNumber("");
    setShowDtmf(false);
    setCallState((prev) => {
      if (prev === "disconnected" || prev === "registering") return prev;
      return "idle";
    });
  }

  function startCallTimer(session: SipSession, direction: "inbound" | "outbound") {
    const start = Date.now();
    activeCallRef.current = {
      session,
      remoteId: "",
      direction,
      startTime: start,
      muted: false,
    };
    callTimerRef.current = setInterval(() => {
      setCallDuration(Math.floor((Date.now() - start) / 1000));
    }, 1000);
  }

  function attachMedia(session: SipSession) {
    try {
      const pc = session?.sessionDescriptionHandler?.peerConnection as RTCPeerConnection | undefined;
      if (!pc) return;

      const remoteStream = new MediaStream();
      pc.getReceivers().forEach((receiver: RTCRtpReceiver) => {
        if (receiver.track) remoteStream.addTrack(receiver.track);
      });

      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = remoteStream;
        remoteAudioRef.current.play().catch(() => {});
      }
    } catch {
      // non-fatal
    }
  }

  function handleVolumeChange(v: number) {
    setVolume(v);
    if (remoteAudioRef.current) {
      remoteAudioRef.current.volume = v;
    }
  }

  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  };

  const inCall = callState === "in-call" || callState === "held" || callState === "ringing-out" || callState === "ringing-in";
  const canDial = callState === "idle" || callState === "dialing";

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50">
      <audio ref={remoteAudioRef} autoPlay className="hidden" />

      {/* Collapsed bar */}
      {!expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex w-full items-center justify-center gap-2 border-t border-white/[0.08] bg-ink-900/95 backdrop-blur-xl px-4 py-3 text-sm font-medium text-white/60 transition hover:text-white hover:bg-ink-850/95"
        >
          <PhoneIcon size={18} className={callState === "in-call" ? "text-mint-400" : callState === "ringing-in" ? "text-sun-400 animate-pulse" : ""} />
          {callState === "idle" && "WebRTC Softphone — Click to open"}
          {callState === "disconnected" && "Softphone — Connect an extension"}
          {callState === "in-call" && `On call · ${formatDuration(callDuration)}`}
          {callState === "ringing-in" && `Incoming from ${incomingCaller}`}
          {callState === "held" && `On hold · ${formatDuration(callDuration)}`}
          {callState === "ringing-out" && `Calling ${dialNumber}...`}
          {callState === "registering" && "Connecting..."}
        </button>
      )}

      {/* Expanded panel */}
      {expanded && (
        <div className="border-t border-white/[0.08] bg-ink-900/95 backdrop-blur-xl animate-slide-up">
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="flex w-full items-center justify-center border-b border-white/[0.06] px-4 py-1.5 text-xs text-white/30 transition hover:text-white/50"
          >
            ▼ Hide softphone
          </button>

          <div className="mx-auto max-w-7xl px-5 py-4 sm:px-8">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-8">
              {/* Left: Extension & volume */}
              <div className="shrink-0 space-y-3 sm:w-64">
                {callState === "disconnected" ? (
                  <>
                    <h3 className="text-sm font-semibold text-white">Connect Extension</h3>
                    {extensions.length === 0 ? (
                      <p className="text-sm text-white/40">
                        No extensions yet. Provision one on the Phone Numbers page first.
                      </p>
                    ) : (
                      <div className="space-y-3">
                        <select
                          className="input-base"
                          value={selectedExtId}
                          onChange={(e) => setSelectedExtId(e.target.value)}
                        >
                          <option value="">Select an extension...</option>
                          {extensions.map((ext) => (
                            <option key={ext.id} value={ext.id}>
                              Ext {ext.extension_id} — {ext.extension_name ?? "Unnamed"}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={connectExtension}
                          disabled={!selectedExtId}
                          className="btn-primary w-full py-2 text-xs"
                        >
                          Connect
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${
                        callState === "idle" || callState === "dialing"
                          ? "bg-mint-400 pulse-dot"
                          : callState === "in-call" || callState === "held"
                            ? "bg-brand-400 pulse-dot"
                            : callState === "ringing-in"
                              ? "bg-sun-400 animate-pulse"
                              : "bg-white/40"
                      }`} />
                      <span className="text-sm font-medium text-white">
                        Ext {selectedExt?.extension_id ?? "?"}
                      </span>
                      <span className="text-xs text-white/35">
                        {selectedExt?.extension_name ?? ""}
                      </span>
                    </div>
                    <div className="text-xs text-white/30">
                      {callState === "idle" && "Ready"}
                      {callState === "registering" && "Registering..."}
                      {callState === "ringing-out" && "Calling..."}
                      {callState === "ringing-in" && "Incoming..."}
                      {callState === "in-call" && "Connected"}
                      {callState === "held" && "On hold"}
                    </div>

                    {/* Volume */}
                    {canDial && (
                      <div className="flex items-center gap-2 pt-2">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/30">
                          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                        </svg>
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.05"
                          value={volume}
                          onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                          className="h-1 w-20 accent-brand-500"
                        />
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={disconnect}
                      className="btn-ghost w-full py-1.5 text-xs"
                    >
                      Disconnect
                    </button>
                  </div>
                )}
              </div>

              {/* Right: UI */}
              <div className="flex-1">
                {/* Incoming call */}
                {callState === "ringing-in" && (
                  <div className="flex flex-col items-center gap-4 py-4 text-center">
                    <div className="flex h-16 w-16 items-center justify-center rounded-full bg-sun-400/15 animate-pulse">
                      <PhoneIcon size={30} className="text-sun-400" />
                    </div>
                    <div>
                      <div className="text-lg font-semibold text-white">Incoming Call</div>
                      <div className="text-sm text-white/45">{incomingCaller}</div>
                    </div>
                    <div className="flex gap-4 mt-2">
                      <button type="button" onClick={rejectCall} className="flex h-14 w-14 items-center justify-center rounded-full bg-rose-500 text-white transition hover:bg-rose-600" title="Reject">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                      </button>
                      <button type="button" onClick={answerCall} className="flex h-14 w-14 items-center justify-center rounded-full bg-mint-500 text-white transition hover:bg-mint-600" title="Answer">
                        <PhoneIcon size={24} />
                      </button>
                    </div>
                  </div>
                )}

                {/* In-call display */}
                {inCall && callState !== "ringing-in" && (
                  <div className="flex flex-col items-center gap-4 py-2 text-center">
                    <div className={`flex h-16 w-16 items-center justify-center rounded-full ${
                      callState === "in-call" ? "bg-mint-500/15" : callState === "held" ? "bg-sun-400/15" : "bg-brand-500/15"
                    }`}>
                      <PhoneIcon size={30} className={
                        callState === "in-call" ? "text-mint-400" : callState === "held" ? "text-sun-400" : "text-brand-300"
                      } />
                    </div>
                    <div>
                      <div className="text-lg font-semibold text-white">
                        {callState === "held" ? "On Hold" : callState === "ringing-out" ? "Ringing..." : "Connected"}
                      </div>
                      <div className="text-sm text-white/45">{dialNumber || "In call"}</div>
                      <div className="mt-1 font-mono text-2xl font-bold text-white">
                        {formatDuration(callDuration)}
                      </div>
                    </div>

                    {/* DTMF toggle */}
                    {callState === "in-call" && (
                      <button
                        type="button"
                        onClick={() => setShowDtmf(!showDtmf)}
                        className="text-xs text-white/40 transition hover:text-white"
                      >
                        {showDtmf ? "Hide keypad" : "Show keypad"}
                      </button>
                    )}

                    {/* DTMF keypad */}
                    {showDtmf && callState === "in-call" && (
                      <div className="grid grid-cols-3 gap-1.5 max-w-[200px]">
                        {["1","2","3","4","5","6","7","8","9","*","0","#"].map((d) => (
                          <button
                            key={d}
                            type="button"
                            onMouseDown={() => sendDtmf(d)}
                            className="rounded-lg border border-white/[0.1] bg-white/[0.04] py-2 text-sm font-semibold text-white transition hover:bg-white/[0.1] active:bg-brand-500/30"
                          >
                            {d}
                          </button>
                        ))}
                      </div>
                    )}

                    <div className="flex gap-4 mt-2">
                      <button type="button" onClick={toggleMute} className={`flex h-12 w-12 items-center justify-center rounded-full border transition ${
                        activeCallRef.current?.muted
                          ? "bg-rose-500/20 border-rose-500/50 text-rose-300"
                          : "border-white/[0.1] bg-white/[0.04] text-white/60 hover:text-white hover:bg-white/[0.08]"
                      }`} title="Mute">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          {activeCallRef.current?.muted ? (
                            <><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" x2="17" y1="9" y2="15"/><line x1="17" x2="23" y1="9" y2="15"/></>
                          ) : (
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                          )}
                        </svg>
                      </button>
                      <button type="button" onClick={toggleHold} className={`flex h-12 w-12 items-center justify-center rounded-full border transition ${
                        callState === "held"
                          ? "bg-sun-400/20 border-sun-400/50 text-sun-400"
                          : "border-white/[0.1] bg-white/[0.04] text-white/60 hover:text-white hover:bg-white/[0.08]"
                      }`} title="Hold">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <line x1="6" x2="6" y1="4" y2="20"/><line x1="18" x2="18" y1="4" y2="20"/>
                        </svg>
                      </button>
                      <button type="button" onClick={hangup} className="flex h-14 w-14 items-center justify-center rounded-full bg-rose-500 text-white transition hover:bg-rose-600" title="Hang up">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" transform="rotate(135)">
                          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.08 4.18 2 2 0 0 1 4.08 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
                        </svg>
                      </button>
                    </div>
                  </div>
                )}

                {/* Dial pad */}
                {canDial && (
                  <div className="space-y-4">
                    <div className="mx-auto max-w-[280px] rounded-2xl border border-white/[0.08] bg-white/[0.03] px-5 py-4 text-center">
                      <div className="min-h-[32px] font-mono text-2xl font-semibold tracking-wider text-white">
                        {dialNumber || <span className="text-white/20">Enter number</span>}
                      </div>
                    </div>
                    <div className="mx-auto grid max-w-[280px] grid-cols-3 gap-2">
                      {["1","2","3","4","5","6","7","8","9","*","0","#"].map((key) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => appendDigit(key)}
                          className="flex flex-col items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.03] py-3 text-white transition hover:bg-white/[0.06] hover:border-white/[0.15] active:scale-95"
                        >
                          <span className="text-xl font-semibold">{key}</span>
                        </button>
                      ))}
                    </div>
                    <div className="mx-auto flex max-w-[280px] gap-3">
                      <button type="button" onClick={clearDial} disabled={!dialNumber} className="btn-ghost flex-1 py-2.5 text-sm">Clear</button>
                      <button type="button" onClick={makeCall} disabled={!dialNumber.trim()} className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-mint-500 text-white transition hover:bg-mint-600 disabled:opacity-30">
                        <PhoneIcon size={22} />
                      </button>
                      <button type="button" onClick={backspaceDial} disabled={!dialNumber} className="btn-ghost flex-1 py-2.5 text-sm">⌫</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
