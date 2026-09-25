"use client";

import { useId, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";

export interface SelectOption {
  value: string;
  /** The line the operator reads first — an extension number, a DID. */
  label: string;
  /** Quieter second line, right-aligned (the extension's name). */
  hint?: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** Accessible name; the visible label normally lives outside the control. */
  ariaLabel?: string;
  /** `sm` is for controls inside a table row, where the form padding is too tall. */
  size?: "sm" | "md";
}

const TRIGGER_SIZE: Record<NonNullable<Props["size"]>, string> = {
  sm: "px-2.5 py-1 text-xs",
  md: "px-4 py-2.5 text-sm",
};

/** Room a drop-up needs, matched to the list's `max-h-64`. */
const LIST_ROOM = 280;

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`shrink-0 text-[var(--text-secondary)] transition-transform ${open ? "rotate-180" : ""}`}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function Check() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0 text-brand-400"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/**
 * The console's dropdown.
 *
 * Deliberately not a native `<select>`. The option list of one is drawn by the
 * operating system, which does not read our theme: on several platforms it
 * comes back a white sheet while the options keep the page's own text colour,
 * which for a list of extension numbers means the thing being chosen is
 * invisible (globals.css tries to patch this through `color-scheme`, but that
 * is a best-effort hint, not a guarantee). Owning both rows and colours makes
 * the choice legible in either theme, in the dashboard and in the pop-out
 * window alike.
 *
 * Keyboard-first, like the rest of the shell: focus stays on the trigger, which
 * points at the active row with `aria-activedescendant`, so ↑/↓/Home/End/Enter
 * work without moving focus into a list that may not exist yet.
 */
export function Select({
  value,
  onChange,
  options,
  placeholder = "Select…",
  disabled = false,
  className = "",
  ariaLabel,
  size = "md",
}: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [dropUp, setDropUp] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listId = useId();

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  function openList() {
    if (disabled || options.length === 0) return;
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
    // The softphone lives in a fixed bottom panel, so a list that always opens
    // downwards would hang off the bottom of the screen. The trigger's own
    // document decides the viewport: when the panel is portalled into the
    // pop-out, `window` here is still the dashboard's, and its height is not the
    // height the list is laid out in.
    const trigger = triggerRef.current;
    const view = trigger?.ownerDocument.defaultView;
    if (trigger && view) {
      const rect = trigger.getBoundingClientRect();
      const below = view.innerHeight - rect.bottom;
      setDropUp(below < LIST_ROOM && rect.top > below);
    }
    setOpen(true);
  }

  function commit(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openList();
      }
      return;
    }
    // The trigger keeps focus while the list is open, so every key arrives here.
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, options.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(options.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commit(active);
    }
  }

  function onBlur(event: FocusEvent<HTMLDivElement>) {
    // Pressing an option moves focus inside the wrapper first, so only a move
    // truly outside is a dismissal.
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setOpen(false);
  }

  return (
    <div className={`relative ${className}`} onBlur={onBlur}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        // The ARIA combobox pattern: focus stays here and points into the list
        // with aria-activedescendant, which only this role supports.
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
        className={`flex w-full items-center justify-between gap-2 rounded-xl border border-[var(--input-border)] bg-[var(--input-bg)] text-left text-[var(--foreground)] outline-none transition focus:border-[var(--input-focus-border)] disabled:cursor-not-allowed disabled:opacity-50 ${TRIGGER_SIZE[size]}`}
      >
        <span className={`min-w-0 truncate ${selected ? "" : "text-[var(--text-muted)]"}`}>
          {selected ? selected.label : placeholder}
        </span>
        <Chevron open={open} />
      </button>

      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className={`absolute left-0 right-0 z-50 max-h-64 overflow-auto rounded-xl border border-[var(--input-border)] bg-ink-850 p-1 shadow-2xl ${
            dropUp ? "bottom-full mb-1" : "top-full mt-1"
          }`}
        >
          {options.map((option, index) => (
            <button
              key={option.value}
              id={`${listId}-${index}`}
              type="button"
              role="option"
              aria-selected={option.value === value}
              tabIndex={-1}
              onMouseEnter={() => setActive(index)}
              onClick={() => commit(index)}
              className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition ${
                index === active ? "bg-white/[0.06]" : ""
              }`}
            >
              <span className="min-w-0 flex-1 truncate text-[var(--foreground)]">{option.label}</span>
              {option.hint && <span className="shrink-0 text-xs text-[var(--text-secondary)]">{option.hint}</span>}
              {option.value === value ? <Check /> : <span className="w-3.5 shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
