"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { ArrowRightIcon } from "@/components/icons";
import { api } from "@/lib/client-api";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    let data: { success: boolean } | undefined;
    try {
      data = await api<{ success: boolean }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Login failed");
      setLoading(false);
      return;
    }

    if (!data?.success) {
      setError("Unexpected response from server. Please try again.");
      setLoading(false);
      return;
    }

    // Verify the session cookie was stored before navigating.
    try {
      const me = await api<{ user?: unknown }>("/api/auth/me");
      if (me?.user) {
        router.push("/dashboard");
        return;
      }
    } catch {
      // session not ready yet — retry after a short delay
    }
    // Retry after a delay — cookies may need time to settle in the browser
    setTimeout(async () => {
      try {
        const me = await api<{ user?: unknown }>("/api/auth/me");
        if (me?.user) {
          router.push("/dashboard");
          return;
        }
      } catch {
        // still not ready
      }
      // If session still isn't valid, show an error instead of navigating
      setError("Session not established. Please try logging in again.");
      setLoading(false);
    }, 500);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-ink-950 px-4 py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Logo size="lg" />
          <p className="mt-3 text-white/45">Welcome back</p>
        </div>

        <div className="card-surface rounded-2xl p-6 sm:p-8">
          {error && (
            <div className="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <label className="block">
              <span className="input-label">Email address</span>
              <input
                className="input-base"
                type="email"
                placeholder="jane@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
            </label>

            <label className="block">
              <span className="input-label">Password</span>
              <input
                className="input-base"
                type="password"
                placeholder="Your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>

            <button
              type="submit"
              disabled={loading}
              className="btn-primary w-full py-2.5 text-sm"
            >
              {loading ? "Signing in..." : "Sign in"}
              {!loading && <ArrowRightIcon size={15} />}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-white/40">
            Don&apos;t have an account?{" "}
            <Link href="/signup" className="font-medium text-brand-300 transition hover:text-brand-200">
              Sign up
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
