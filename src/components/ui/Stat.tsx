import type { ReactNode } from "react";

/**
 * One number worth knowing at a glance.
 *
 * `hint` is where the number came from, because a count an operator cannot
 * trace is a count they cannot act on.
 */
export function Stat({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  icon?: ReactNode;
}) {
  return (
    <div
      className="rounded-2xl border p-4"
      style={{ background: "var(--card-surface-bg)", borderColor: "var(--surface-border)" }}
    >
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-white/35">
        {icon}
        {label}
      </div>
      <div className="mt-1.5 text-2xl font-semibold tabular-nums text-white">{value}</div>
      {hint ? <div className="mt-0.5 truncate text-xs text-white/35">{hint}</div> : null}
    </div>
  );
}
