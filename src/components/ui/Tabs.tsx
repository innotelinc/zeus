"use client";

import type { ReactNode } from "react";

export interface TabItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Optional count shown beside the label. */
  count?: number | null;
}

/**
 * A tab bar for a screen with several facets of one job.
 *
 * Deliberately controlled: the screen owns which facet is open, because it is
 * often the same state a URL or a poll needs to read.
 */
export function Tabs({
  tabs,
  active,
  onChange,
  className = "",
}: {
  tabs: TabItem[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={`flex flex-wrap items-center gap-1 rounded-xl border p-1 ${className}`}
      style={{ background: "var(--surface-bg)", borderColor: "var(--surface-border)" }}
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab.id)}
            className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              selected
                ? "bg-brand-500/15 text-brand-200"
                : "text-white/45 hover:bg-white/[0.04] hover:text-white"
            }`}
          >
            {tab.icon}
            {tab.label}
            {tab.count != null ? (
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${
                  selected ? "bg-brand-500/20 text-brand-200" : "bg-white/[0.06] text-white/40"
                }`}
              >
                {tab.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
