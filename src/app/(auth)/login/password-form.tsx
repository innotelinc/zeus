"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRightIcon } from "@/components/icons";
import { api } from "@/lib/client-api";

export function PasswordLoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      await api<{ success: boolean }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      setLoading(false);
      return;
    }

    try {
      const me = await api<{ user?: unknown }>("/api/auth/me");
      if (me?.user) {
        router.push(next);
        router.refresh();
        return;
      }
    } catch {
      // session may not be visible yet — retry once below
    }
    setTimeout(async () => {
      try {
        const me = await api<{ user?: unknown }>("/api/auth/me");
        if (me?.user) {
          router.push(next);
          router.refresh();
          return;
        }
      } catch {
        // still not ready
      }
      setError("Session not established. Please try logging in again.");
      setLoading(false);
    }, 500);
  }

  return (
    <>
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
    </>
  );
}