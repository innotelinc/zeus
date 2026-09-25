import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "ghost";

interface BaseProps {
  children: ReactNode;
  variant?: Variant;
  className?: string;
  /** Small inline control (used in tables and toolbars). */
  size?: "sm" | "md";
}

type ButtonProps = BaseProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> & {
    href?: undefined;
  };

type LinkProps = BaseProps & {
  href: string;
  /** Links that leave the shell say so and open a new tab by default. */
  external?: boolean;
  title?: string;
};

const SIZE = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
} as const;

function classes(variant: Variant, size: "sm" | "md", extra: string) {
  const base =
    variant === "primary"
      ? "btn-primary"
      : "border border-[var(--btn-ghost-border)] bg-[var(--btn-ghost-bg)] text-[var(--btn-ghost-color)] transition hover:bg-[var(--btn-ghost-hover-bg)]";
  return `inline-flex items-center justify-center gap-1.5 rounded-lg font-medium disabled:cursor-not-allowed disabled:opacity-40 ${base} ${SIZE[size]} ${extra}`;
}

/**
 * The one button.
 *
 * `primary` for the action the screen exists for; `ghost` for everything else.
 * It is presentational on purpose (no "use client"), so a server screen can
 * render a link variant without pulling a client boundary in.
 */
export function Button(props: ButtonProps | LinkProps) {
  if ("href" in props && props.href !== undefined) {
    const { children, variant = "ghost", size = "md", className = "", href, external, title } = props;
    return (
      <a
        href={href}
        title={title}
        className={classes(variant, size, className)}
        {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      >
        {children}
      </a>
    );
  }

  const {
    children,
    variant = "ghost",
    size = "md",
    className = "",
    ...rest
  } = props as ButtonProps;
  return (
    <button type="button" className={classes(variant, size, className)} {...rest}>
      {children}
    </button>
  );
}
