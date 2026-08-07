"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";

// ── Types ──

export interface Toast {
  id: string;
  variant: "success" | "error" | "info";
  message: string;
}

interface ToastContextValue {
  toast: {
    success: (message: string) => void;
    error: (message: string) => void;
    info: (message: string) => void;
  };
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_DURATION = 4000;
const MAX_TOASTS = 5;

// ── Provider ──

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const counter = useRef(0);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const addToast = useCallback(
    (variant: Toast["variant"], message: string) => {
      const id = `${Date.now()}-${++counter.current}`;

      setToasts((prev) => {
        const next = [...prev, { id, variant, message }];
        // Keep at most MAX_TOASTS, removing oldest first
        while (next.length > MAX_TOASTS) {
          const removed = next.shift()!;
          const timer = timers.current.get(removed.id);
          if (timer) {
            clearTimeout(timer);
            timers.current.delete(removed.id);
          }
        }
        return next;
      });

      // Auto-dismiss
      const timer = setTimeout(() => removeToast(id), TOAST_DURATION);
      timers.current.set(id, timer);
    },
    [removeToast],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      timers.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  const ctx: ToastContextValue = {
    toast: {
      success: (msg: string) => addToast("success", msg),
      error: (msg: string) => addToast("error", msg),
      info: (msg: string) => addToast("info", msg),
    },
  };

  const variantStyles: Record<Toast["variant"], string> = {
    success:
      "border-mint-500/30 bg-mint-500/10 text-mint-200",
    error:
      "border-rose-500/30 bg-rose-500/10 text-rose-200",
    info: "border-brand-500/30 bg-brand-500/10 text-brand-200",
  };

  const variantBars: Record<Toast["variant"], string> = {
    success: "bg-mint-400",
    error: "bg-rose-400",
    info: "bg-brand-400",
  };

  return (
    <ToastContext.Provider value={ctx}>
      {children}

      {/* Toast container — fixed top-right */}
      <div
        aria-live="polite"
        className="fixed right-4 top-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 pointer-events-none"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="alert"
            className={`pointer-events-auto animate-toast-in rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur-sm ${variantStyles[t.variant]}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex-1">{t.message}</span>
              <button
                type="button"
                onClick={() => removeToast(t.id)}
                className="shrink-0 rounded-md p-0.5 opacity-50 hover:opacity-100 transition"
                aria-label="Dismiss"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            {/* Countdown bar */}
            <div className="mt-2 h-0.5 w-full rounded-full bg-white/[0.06] overflow-hidden">
              <div
                className={`h-full rounded-full ${variantBars[t.variant]} animate-toast-bar`}
              />
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ── Hook ──

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a <ToastProvider>");
  }
  return ctx;
}

// ── Global CSS keyframes injected at module level ──
// (Next.js global.css handles these — see globals.css for @keyframes)
