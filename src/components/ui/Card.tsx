import type { ReactNode } from "react";

/**
 * A panel. The one surface every module composes.
 *
 * It reads the `--surface-*` tokens rather than hard-coding `bg-white/[0.02]`
 * so a module cannot invent a second panel colour, and light/dark are handled
 * by the token layer instead of per-component overrides.
 */
export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl border p-5 ${className}`}
      style={{ background: "var(--card-surface-bg)", borderColor: "var(--surface-border)" }}
    >
      {children}
    </section>
  );
}

/**
 * A titled section inside (or instead of) a Card.
 *
 * `answers` is the operator's question — the same convention the nav uses — so
 * a heading explains why the panel exists rather than restating its label.
 */
export function CardHeader({
  title,
  answers,
  icon,
  actions,
}: {
  title: string;
  answers?: string;
  icon?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
          {icon}
          {title}
        </h2>
        {answers ? <p className="mt-0.5 text-xs text-white/40">{answers}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
