import { Suspense } from "react";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { ArrowRightIcon } from "@/components/icons";
import { passwordLoginEnabled, ssoLoginEnabled } from "@/lib/oidc";
import { DevSignupForm } from "./dev-form";

export const dynamic = "force-dynamic";

export default async function SignupPage() {
  const sso = ssoLoginEnabled();
  const password = passwordLoginEnabled();

  return (
    <div className="min-h-screen flex items-center justify-center bg-ink-950 px-4 py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Logo size="lg" />
          <p className="mt-3 text-white/45">
            {sso ? "Create your Zeus account" : "Create your account"}
          </p>
        </div>

        <div className="card-surface rounded-2xl p-6 sm:p-8">
          {sso && password ? (
            <>
              <h2 className="text-lg font-semibold text-white">
                Create your account locally
              </h2>
              <p className="mt-2 text-sm text-white/45">
                Zeus runs in hybrid auth mode: sign-up below creates a local
                account, or use the organization-wide Authentik account.
              </p>
              <a
                href="/api/auth/authentik/login?next=/dashboard"
                className="btn-ghost mt-4 w-full py-2.5 text-sm"
              >
                Continue with Authentik
                <ArrowRightIcon size={15} />
              </a>
              <div className="my-4 flex items-center gap-3 text-xs text-white/30">
                <span className="h-px flex-1 bg-white/10" />
                or create a local account
                <span className="h-px flex-1 bg-white/10" />
              </div>
              <Suspense>
                <DevSignupForm />
              </Suspense>
            </>
          ) : sso ? (
            <>
              <h2 className="text-lg font-semibold text-white">
                Accounts are managed by Authentik
              </h2>
              <p className="mt-2 text-sm text-white/45">
                Zeus uses Authentik for authentication and user management. Create
                your account there and you&apos;ll be signed in automatically —
                passwords, security, and profile details all live in one place.
              </p>
              <a
                href="/api/auth/authentik/login?next=/dashboard"
                className="btn-primary mt-6 w-full py-2.5 text-sm"
              >
                Continue with Authentik
                <ArrowRightIcon size={15} />
              </a>
            </>
          ) : (
            <Suspense>
              <DevSignupForm />
            </Suspense>
          )}
        </div>

        <p className="mt-6 text-center text-sm text-white/40">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-brand-300 transition hover:text-brand-200">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}