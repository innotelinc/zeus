import type { ReactNode } from "react";

/** The one status vocabulary. A module picks a tone, not an ad-hoc colour. */
export type BadgeTone = "neutral" | "brand" | "success" | "warning" | "danger" | "muted";

const TONE: Record<BadgeTone, string> = {
  neutral: "border-white/[0.08] bg-white/[0.03] text-white/50",
  brand: "border-brand-500/25 bg-brand-500/10 text-brand-300",
  success: "border-mint-500/30 bg-mint-500/10 text-mint-400",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  danger: "border-rose-500/30 bg-rose-500/10 text-rose-300",
  muted: "border-white/[0.06] bg-transparent text-white/35",
};

export function Badge({
  children,
  tone = "neutral",
  className = "",
  title,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${TONE[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/** A small live dot, for "this is happening now". */
export function Dot({ tone = "success" }: { tone?: "success" | "danger" | "neutral" }) {
  const colour =
    tone === "success" ? "bg-mint-400" : tone === "danger" ? "bg-rose-400" : "bg-white/40";
  return <span className={`h-1.5 w-1.5 rounded-full ${colour}`} />;
}
