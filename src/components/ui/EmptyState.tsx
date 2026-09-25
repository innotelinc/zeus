import type { ReactNode } from "react";

/**
 * The "nothing here" state.
 *
 * The design rule: an empty state says what would fill it and how, never just
 * "no data" — an operator reading an empty panel cannot tell a quiet system
 * from a broken one without that sentence.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-white/[0.08] px-6 py-10 text-center">
      {icon ? <div className="text-white/25">{icon}</div> : null}
      <p className="text-sm font-medium text-white/70">{title}</p>
      {description ? (
        <p className="max-w-md text-xs leading-relaxed text-white/40">{description}</p>
      ) : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
