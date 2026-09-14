"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRightIcon } from "@/components/icons";
import { api } from "@/lib/client-api";

export function DevSignupForm() {
  const router = useRouter();
  const params = useSearchParams();
  // One plan for everyone — no Business tier. The plan slug stays `consumer`
  // so signups land on the plan the portal already provisions numbers for.
  void params;

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      await api("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ name, email, password, plan: "consumer", phone: phone || null }),
      });
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Signup failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {/* Plan — one plan for everyone, so there is nothing to choose. */}
      <div className="mb-6">
        <label className="input-label">Your plan</label>
        <div className="rounded-xl border border-brand-500/60 bg-brand-500/10 p-4 ring-1 ring-brand-500/30">
          <div className="text-sm font-semibold text-white">Zeus Phone</div>
          <div className="mt-1 text-xs text-white/40">$19.99/mo</div>
          <div className="mt-1 text-xs text-white/30">Your own number, SMS, fax and voicemail — for everyone. AI voice agents are available as an add-on.</div>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <label className="block">
          <span className="input-label">Full name</span>
          <input
            className="input-base"
            type="text"
            placeholder="Jane Smith"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            minLength={2}
          />
        </label>

        <label className="block">
          <span className="input-label">Email address</span>
          <input
            className="input-base"
            type="email"
            placeholder="jane@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>

        <label className="block">
          <span className="input-label">Password</span>
          <input
            className="input-base"
            type="password"
            placeholder="At least 8 characters"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
        </label>

        <label className="block">
          <span className="input-label">Phone number (optional)</span>
          <input
            className="input-base"
            type="tel"
            placeholder="+1 555 123 4567"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </label>

        <button
          type="submit"
          disabled={loading}
          className="btn-primary w-full py-2.5 text-sm"
        >
          {loading ? "Creating account..." : "Create account"}
          {!loading && <ArrowRightIcon size={15} />}
        </button>
      </form>
    </>
  );
}