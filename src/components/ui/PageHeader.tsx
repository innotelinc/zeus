import type { ReactNode } from "react";

/**
 * The top of a screen: what it is, why it exists, and what you can do here.
 *
 * Every module opens with this, so an operator lands in a consistent place —
 * title, one-sentence purpose, and the actions that belong to the screen as a
 * whole (not to one panel).
 */
export function PageHeader({
  title,
  description,
  icon,
  actions,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-white">
          {icon}
          {title}
        </h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-white/50">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
