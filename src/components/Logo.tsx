import Link from "next/link";
import { PhoneIcon } from "./icons";

/** White-label brand name — override per deployment/reseller via env. */
export function brandName(): string {
  return process.env.NEXT_PUBLIC_BRAND_NAME ?? "Zeus";
}

/**
 * Brand lockup: an icon tile plus the gradient wordmark.
 *
 * Matches the Magnate lockup (rounded brand-coloured square holding the mark,
 * gradient wordmark beside it) so the whole platform reads as one family. The
 * label still honours the white-label override, so a reseller swap only changes
 * the text.
 */
const SIZES = {
  sm: { tile: "h-8 w-8 rounded-lg", icon: 15, text: "text-lg", gap: "gap-2" },
  md: { tile: "h-9 w-9 rounded-xl", icon: 17, text: "text-xl", gap: "gap-2.5" },
  lg: { tile: "h-11 w-11 rounded-xl", icon: 20, text: "text-3xl", gap: "gap-3" },
} as const;

export function Logo({
  size = "md",
  name,
}: {
  size?: "sm" | "md" | "lg";
  /** Explicit white-label brand (e.g. a reseller) — overrides env/default. */
  name?: string;
}) {
  const s = SIZES[size];
  const label = name && name.trim() ? name : brandName();
  return (
    <Link href="/" className={`group flex items-center ${s.gap}`}>
      <span
        aria-hidden
        className={`flex ${s.tile} items-center justify-center bg-brand-600 shadow-lg shadow-brand-600/30 transition-transform duration-300 group-hover:scale-105`}
      >
        <PhoneIcon size={s.icon} className="text-white" />
      </span>
      <span className={`${s.text} font-semibold tracking-tight`}>
        <span className="bg-gradient-to-r from-white via-brand-200 to-brand-400 bg-clip-text text-transparent">
          {label}
        </span>
        <span className="text-brand-400">.</span>
      </span>
    </Link>
  );
}
