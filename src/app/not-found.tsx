import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-ink-950 px-5 text-center">
      <p className="text-sm font-medium uppercase tracking-widest text-brand-400">404</p>
      <h1 className="mt-4 text-3xl font-bold text-white">Page not found</h1>
      <p className="mt-3 max-w-md text-white/50">
        The page you are looking for doesn&apos;t exist or has been moved.
      </p>
      <Link
        href="/"
        className="btn-primary mt-8 px-6 py-2.5 text-sm"
      >
        Back to home
      </Link>
    </div>
  );
}
