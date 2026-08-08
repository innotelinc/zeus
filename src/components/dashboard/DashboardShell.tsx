"use client";

import { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/Logo";
import {
  PhoneIcon,
  MessageIcon,
  FaxIcon,
  VoicemailIcon,
  HistoryIcon,
  CreditCardIcon,
  CogIcon,
  LogoutIcon,
  UserIcon,
} from "@/components/icons";
import type { User, FreePBXExtension } from "@/lib/types";
import { planLabel } from "@/lib/client-api";
import { ToastProvider } from "@/components/ToastProvider";

// Lazy-load SoftphoneSection (sip.js) — browser-only WebRTC, must not SSR
const SoftphoneSection = dynamic(
  () => import("@/components/dashboard/SoftphoneSection"),
  { ssr: false },
);

interface Props {
  user: User;
  extensions: FreePBXExtension[];
  children: React.ReactNode;
}

const navItems = [
  { href: "/dashboard", label: "Phone Numbers", icon: PhoneIcon },
  { href: "/dashboard/messages", label: "Messages", icon: MessageIcon },
  { href: "/dashboard/contacts", label: "Contacts", icon: UserIcon },
  { href: "/dashboard/fax", label: "Fax", icon: FaxIcon },
  { href: "/dashboard/voicemail", label: "Voicemail", icon: VoicemailIcon },
  { href: "/dashboard/history", label: "Call History", icon: HistoryIcon },
  { href: "/dashboard/billing", label: "Billing", icon: CreditCardIcon },
  { href: "/dashboard/settings", label: "Settings", icon: CogIcon },
];

export function DashboardShell({ user, extensions, children }: Props) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [amiConnected, setAmiConnected] = useState<boolean | null>(null);
  const [activeCalls, setActiveCalls] = useState(0);

  // Poll AMI status every 15s
  useEffect(() => {
    async function poll() {
      try {
        const res = await fetch("/api/ami/status");
        const data = await res.json();
        setAmiConnected(data.ami_connected);
        setActiveCalls(data.active_calls ?? 0);
      } catch {
        setAmiConnected(false);
      }
    }
    poll();
    const interval = setInterval(poll, 15_000);
    return () => clearInterval(interval);
  }, []);

  const isActive = (href: string) =>
    href === "/dashboard"
      ? pathname === "/dashboard"
      : (pathname?.startsWith(href) ?? false);

  return (
    <ToastProvider>
    <div className="min-h-screen bg-ink-950">
      {/* Top bar */}
      <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-ink-950/85 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 sm:px-8">
          <div className="flex items-center gap-4">
            <Logo size="sm" />
            <span className="hidden rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-0.5 text-xs font-medium text-white/40 sm:inline-block">
              {planLabel(user.plan)}
            </span>
            {/* AMI status indicator */}
            {amiConnected !== null && (
              <span
                className={`hidden items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium sm:inline-flex ${
                  amiConnected
                    ? "border-mint-500/30 bg-mint-500/10 text-mint-400"
                    : "border-rose-500/30 bg-rose-500/10 text-rose-300"
                }`}
                title={amiConnected ? "Asterisk AMI connected" : "AMI disconnected"}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${amiConnected ? "bg-mint-400" : "bg-rose-400"}`} />
                {amiConnected ? (activeCalls > 0 ? `${activeCalls} active` : "Live") : "AMI Offline"}
              </span>
            )}
          </div>

          <div className="flex items-center gap-4">
            {/* Mobile menu toggle */}
            <button
              type="button"
              onClick={() => setMobileOpen(!mobileOpen)}
              className="rounded-lg border border-white/[0.1] bg-white/[0.04] p-2 text-white/60 transition hover:text-white sm:hidden"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                {mobileOpen ? (
                  <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>
                ) : (
                  <><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="18" x2="21" y2="18" /></>
                )}
              </svg>
            </button>

            <div className="flex items-center gap-3">
              <UserIcon size={18} className="text-white/40" />
              <span className="hidden text-sm text-white/60 sm:inline">{user.email}</span>
            </div>

            <Link
              href="/api/auth/logout"
              className="rounded-lg border border-white/[0.08] bg-white/[0.03] p-2 text-white/50 transition hover:text-white hover:bg-white/[0.06]"
              title="Sign out"
            >
              <LogoutIcon size={16} />
            </Link>
          </div>
        </div>
      </header>

      {/* Sidebar + Content */}
      <div className="mx-auto flex max-w-7xl gap-8 px-5 py-8 sm:px-8">
        {/* Desktop sidebar */}
        <aside className="hidden w-56 shrink-0 sm:block">
          <nav className="sticky top-24 space-y-1">
            {navItems.map((item) => {
              const active = isActive(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-3 rounded-xl px-4 py-2.5 text-sm font-medium transition ${
                    active
                      ? "bg-brand-500/15 text-brand-300"
                      : "text-white/50 hover:bg-white/[0.04] hover:text-white"
                  }`}
                >
                  <item.icon size={18} />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </aside>

        {/* Mobile menu */}
        {mobileOpen && (
          <div className="fixed inset-0 top-16 z-30 bg-ink-950/95 backdrop-blur-sm sm:hidden">
            <nav className="flex flex-col gap-1 p-5">
              {navItems.map((item) => {
                const active = isActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileOpen(false)}
                    className={`flex items-center gap-3 rounded-xl px-4 py-3 text-base font-medium transition ${
                      active
                        ? "bg-brand-500/15 text-brand-300"
                        : "text-white/50 hover:bg-white/[0.04] hover:text-white"
                    }`}
                  >
                    <item.icon size={20} />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>
        )}

        {/* Content */}
        <main className="min-w-0 flex-1 pb-16">{children}</main>
      </div>

      {/* Softphone panel */}
      <SoftphoneSection extensions={extensions} />
    </div>
    </ToastProvider>
  );
}
