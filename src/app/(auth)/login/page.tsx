import Link from "next/link";
import { Logo } from "@/components/Logo";
import { oidcEnabled } from "@/lib/oidc";
import { PasswordLoginForm } from "./password-form";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;
  const sso = oidcEnabled();
  const next = params.next?.startsWith("/") && !params.next.startsWith("//")
    ? params.next
    : "/dashboard";

  const errorMessages: Record<string, string> = {
    access_denied: "Sign-in was cancelled.",
    state_mismatch: "Sign-in session expired or was tampered with — try again.",
    exchange_failed: "Could not complete the sign-in. Please try again.",
    user_provision_failed: "Your account could not be set up. Contact support.",
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-ink-950 px-4 py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Logo size="lg" />
          <p className="mt-3 text-white/45">
            {sso ? "Sign in with your Zeus account" : "Welcome back"}
          </p>
        </div>

        <div className="card-surface rounded-2xl p-6 sm:p-8">
          {params.error && (
            <div className="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
              {errorMessages[params.error] ?? "Sign-in failed. Please try again."}
            </div>
          )}

          {sso ? (
            <>
              <a
                href={`/api/auth/authentik/login?next=${encodeURIComponent(next)}`}
                className="btn-primary w-full py-2.5 text-sm"
              >
                Continue with Authentik
              </a>
              <p className="mt-4 text-center text-xs text-white/35">
                Accounts are managed by Authentik — self-service registration,
                passwords, and security live there.
              </p>
            </>
          ) : (
            <PasswordLoginForm next={next} />
          )}
        </div>

        {sso ? (
          <p className="mt-6 text-center text-xs text-white/30">
            No account yet? Ask an administrator to create one in Authentik.
          </p>
        ) : (
          <p className="mt-6 text-center text-sm text-white/40">
            Don&apos;t have an account?{" "}
            <Link href={`/signup${next && next !== "/dashboard" ? `?next=${encodeURIComponent(next)}` : ""}`} className="font-medium text-brand-300 transition hover:text-brand-200">
              Sign up
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}