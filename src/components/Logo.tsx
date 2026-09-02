import Link from "next/link";

/** White-label brand name — override per deployment/reseller via env. */
export function brandName(): string {
  return process.env.NEXT_PUBLIC_BRAND_NAME ?? "Zeus";
}

export function Logo({
  size = "md",
  name,
}: {
  size?: "sm" | "md" | "lg";
  /** Explicit white-label brand (e.g. a reseller) — overrides env/default. */
  name?: string;
}) {
  const cls =
    size === "sm"
      ? "text-lg"
      : size === "lg"
        ? "text-3xl"
        : "text-xl";
  const label = name && name.trim() ? name : brandName();
  return (
    <Link href="/" className={`${cls} font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white via-brand-200 to-brand-400`}>
      {label}<span className="text-brand-400">.</span>
    </Link>
  );
}