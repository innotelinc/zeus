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
  HeartPulseIcon,
  SparklesIcon,
  FileTextIcon,
} from "@/components/icons";
import type { User, FreePBXExtension, PhoneNumber } from "@/lib/types";
import type { AddonSku, AddonUiState } from "@/lib/addons";
import { proxiedUrl, groupedSurfaces, type ConsoleSurface } from "@/lib/console";
import { planLabel } from "@/lib/client-api";
import { ToastProvider } from "@/components/ToastProvider";
import { ThemeProvider, useTheme } from "@/components/ThemeProvider";

// Lazy-load SoftphoneSection (sip.js) — browser-only WebRTC, must not SSR
const SoftphoneSection = dynamic(
  () => import("@/components/dashboard/SoftphoneSection"),
  { ssr: false },
);

interface Props {
  user: User;
  extensions: FreePBXExtension[];
  phoneNumbers: PhoneNumber[];
  /** White-label brand name (reseller domain override) — null = platform brand. */
  brand?: string | null;
  /**
   * Add-on state per voice SKU, resolved server-side by the dashboard layout.
   * A nav entry appears only when its add-on is enabled — the screens behind
   * them (Voice, Capstone) gate themselves too, so hiding the link and
   * refusing the route come from the same decision.
   */
  voiceAddons?: Partial<Record<AddonSku, AddonUiState>>;
  children: React.ReactNode;
}

type IconFn = ({ size }: { size?: number }) => React.ReactElement;

/**
 * The icon for each surface, keyed by the registry's id.
 *
 * The rail's structure lives in `lib/console.ts` and only its *decoration*
 * lives here — that is what keeps the rail and `/dashboard/estate` from
 * disagreeing about which screens exist. A surface added to the registry with
 * no icon here still appears; it gets the neutral dot.
 */
const SURFACE_ICONS: Record<string, IconFn> = {
  overview: LayoutIcon,
  numbers: PhoneIcon,
  history: HistoryIcon,
  "live-pbx": GridIcon,
  voice: SparklesIcon,
  agents: FlowIcon,
  interviews: FileTextIcon,
  workflows: FlowIcon,
  "workflow-studio": FlowIcon,
  voicemail: VoicemailIcon,
  fax: FaxIcon,
  "fax-archive": FaxIcon,
  messages: MessageIcon,
  contacts: UserIcon,
  billing: CreditCardIcon,
  settings: CogIcon,
  estate: MapIcon,
  health: HeartPulseIcon,
  operations: GridIcon,
  "pbx-admin": GridIcon,
  "capstone-dashboard": LayoutIcon,
  admin: ShieldIcon,
};

function DotIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function FlowIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="6" height="6" rx="1" />
      <rect x="15" y="15" width="6" height="6" rx="1" />
      <path d="M9 6h6a3 3 0 0 1 3 3v6" />
    </svg>
  );
}

function GridIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function LayoutIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );
}

function MapIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 3 3 6v15l6-3 6 3 6-3V3l-6 3-6-3Z" />
      <line x1="9" y1="3" x2="9" y2="18" />
      <line x1="15" y1="6" x2="15" y2="21" />
    </svg>
  );
}

function ShieldIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
  );
}

function ThemeToggle() {
  const { theme, setTheme, resolved } = useTheme();

  function cycle() {
    if (theme === "dark") setTheme("light");
    else if (theme === "light") setTheme("system");
    else setTheme("dark");
  }

  const icons: Record<string, string> = {
    dark: "🌙",
    light: "☀️",
    system: "💻",
  };

  return (
    <button
      type="button"
      onClick={cycle}
      className="rounded-lg border border-white/[0.08] bg-white/[0.03] p-2 text-sm transition hover:bg-white/[0.06]"
      title={`Theme: ${theme} (${resolved})`}
    >
      {icons[theme]}
    </button>
  );
}

export function DashboardShell({ user, extensions, phoneNumbers, brand, voiceAddons, children }: Props) {
  const pathname = usePathname();

  // The rail is rendered from the console registry, so this component and
  // `/dashboard/estate` cannot disagree about which screens exist. Add-on-gated
  // entries are dropped unless the add-on is "enabled": an "unknown" state
  // (billing unreachable) hides them too, because the screen behind would
  // refuse to render anyway and a dead link is worse than no link.
  const groups = groupedSurfaces({
    isAdmin: user.role === "admin",
    addons: {
      agents: voiceAddons?.agents,
      capstone: voiceAddons?.capstone,
    },
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [amiConnected, setAmiConnected] = useState<boolean | null>(null);
  const [activeCalls, setActiveCalls] = useState(0);

  // Poll AMI status every 15s
  useEffect(() => {
    async function poll() {
      try {
        const res = await fetch("/api/ami/status", {
          credentials: "include",
        });
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

  const isActive = (href: string | undefined) =>
    !href ? false : href === "/dashboard"
      ? pathname === "/dashboard"
      : (pathname?.startsWith(href) ?? false);

  /** One rail entry. Owned surfaces navigate; proxied ones leave, and say so. */
  function RailLink({
    surface,
    size,
    onNavigate,
  }: {
    surface: ConsoleSurface;
    size: number;
    onNavigate?: () => void;
  }) {
    const Icon = SURFACE_ICONS[surface.id] ?? DotIcon;

    if (surface.kind === "proxied") {
      const href = proxiedUrl(surface);
      if (!href) return null;
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          onClick={onNavigate}
          title={`${surface.answers} — opens ${surface.product}`}
          className="flex items-center gap-3 rounded-xl px-4 py-2.5 text-sm font-medium text-white/40 transition hover:bg-white/[0.04] hover:text-white"
        >
          <Icon size={size} />
          <span className="min-w-0 flex-1 truncate">{surface.label}</span>
          {/* A proxied surface is labelled wherever it appears, so an operator
              is never unsure which product they are looking at. */}
          <span className="shrink-0 text-[10px] text-white/25">↗</span>
        </a>
      );
    }

    const active = isActive(surface.href);
    return (
      <Link
        href={surface.href ?? "/dashboard"}
        onClick={onNavigate}
        className={`flex items-center gap-3 rounded-xl px-4 py-2.5 text-sm font-medium transition ${
          active
            ? "bg-brand-500/15 text-brand-300"
            : "text-white/50 hover:bg-white/[0.04] hover:text-white"
        }`}
      >
        <Icon size={size} />
        <span className="min-w-0 flex-1 truncate">{surface.label}</span>
      </Link>
    );
  }

  return (
    <ThemeProvider>
    <ToastProvider>
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      {/* Top bar */}
      <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-ink-950/85 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 sm:px-8">
          <div className="flex items-center gap-4">
            <Logo size="sm" name={brand ?? undefined} />
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

            <ThemeToggle />

            <div className="flex items-center gap-3">
              <UserIcon size={18} className="text-white/40" />
              <span className="hidden text-sm text-white/60 sm:inline">{user.email}</span>
            </div>

            {/* Plain <a>, not next/link: the route 302s to Authentik's
                end-session page, and a soft navigation to cross-origin HTML
                fails silently — sign-out looked like a dead button. */}
            <a
              href="/api/auth/logout"
              className="rounded-lg border border-white/[0.08] bg-white/[0.03] p-2 text-white/50 transition hover:text-white hover:bg-white/[0.06]"
              title="Sign out"
            >
              <LogoutIcon size={16} />
            </a>
          </div>
        </div>
      </header>

      {/* Sidebar + Content */}
      <div className="mx-auto flex max-w-7xl gap-8 px-5 py-8 sm:px-8">
        {/* Desktop sidebar — grouped by the question, not by the product that
            answers it. See lib/console.ts. */}
        <aside className="hidden w-56 shrink-0 sm:block">
          <nav className="sticky top-24 space-y-4">
            {groups.map((group) => (
              <div key={group.id} className="space-y-1">
                <div
                  className="px-4 pb-1 text-[10px] font-semibold uppercase tracking-wider text-white/25"
                  title={group.answers}
                >
                  {group.label}
                </div>
                {group.surfaces.map((surface) =>
                  RailLink({ surface, size: 18 }),
                )}
              </div>
            ))}
          </nav>
        </aside>

        {/* Mobile menu */}
        {mobileOpen && (
          <div className="fixed inset-0 top-16 z-30 bg-ink-950/95 backdrop-blur-sm sm:hidden">
            <nav className="flex flex-col gap-4 overflow-y-auto p-5">
              {groups.map((group) => (
                <div key={group.id} className="space-y-1">
                  <div className="px-4 pb-1 text-[10px] font-semibold uppercase tracking-wider text-white/25">
                    {group.label}
                  </div>
                  {/* Each entry is its own element so the rail's active state
                      and the proxied label are identical on both breakpoints. */}
                  {group.surfaces.map((surface) => (
                    <div key={surface.id} className="text-base">
                      {RailLink({
                        surface,
                        size: 20,
                        onNavigate: () => setMobileOpen(false),
                      })}
                    </div>
                  ))}
                </div>
              ))}
            </nav>
          </div>
        )}

        {/* Content */}
        <main className="min-w-0 flex-1 pb-16">{children}</main>
      </div>

      {/* Softphone panel */}
      <SoftphoneSection extensions={extensions} phoneNumbers={phoneNumbers} />
    </div>
    </ToastProvider>
    </ThemeProvider>
  );
}
