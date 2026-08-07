import Link from "next/link";

export function Logo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const cls =
    size === "sm"
      ? "text-lg"
      : size === "lg"
        ? "text-3xl"
        : "text-xl";
  return (
    <Link href="/" className={`${cls} font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white via-brand-200 to-brand-400`}>
      Innotel<span className="text-brand-400">.</span>
    </Link>
  );
}
