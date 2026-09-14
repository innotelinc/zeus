import Link from "next/link";
import { Logo } from "@/components/Logo";
import { ArrowRightIcon, CheckCircleIcon, CreditCardIcon, PhoneIcon } from "@/components/icons";
import { subscribeCatalog } from "@/lib/catalog";
import { ssoLoginEnabled } from "@/lib/oidc";

const MAGNATE_URL = (process.env.MAGNATE_PUBLIC_URL || "https://app.magnate.innotel.us").replace(/\/+$/, "");
const SUBSCRIBE_URL = (process.env.MAGNATE_SUBSCRIBE_URL || "https://subscribe.innotel.us").replace(/\/+$/, "");

function signInHref(path = ""): string {
  if (ssoLoginEnabled()) {
    return "/api/auth/authentik/login" + (path ? `?next=${encodeURIComponent(path)}` : "");
  }
  return "/login" + path;
}

/**
 * The Zeus subscription page — the page a buyer lands on, separate from the
 * portal they use afterwards.
 *
 * Served twice from this one deployment: `/subscribe` here, and as `/` on the
 * `subscribe.` hostname (see app/page.tsx). Billing is Magnate's, so the
 * add-on's button hands off to its checkout; the phone plan starts at this
 * portal's own sign-up, where the number and extension are provisioned.
 */
export async function SubscribeLanding() {
  const { phone, agents } = subscribeCatalog();
  const plans = [phone, agents];

  return (
    <div className="min-h-screen bg-ink-950">
      {/* Nav */}
      <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-ink-950/85 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 sm:px-8">
          <Logo size="sm" />
          <div className="flex items-center gap-4">
            <Link href="/" className="text-sm font-medium text-white/60 transition hover:text-white">
              Back to Zeus
            </Link>
            <Link href={signInHref()} className="text-sm font-medium text-white/60 transition hover:text-white">
              Sign in
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-grid" />
        <div className="relative mx-auto max-w-7xl px-5 pb-14 pt-16 sm:px-8 sm:pb-16 sm:pt-24">
          <div className="mx-auto max-w-3xl text-center">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-brand-500/30 bg-brand-500/10 px-4 py-1.5">
              <CreditCardIcon size={13} className="text-brand-300" />
              <span className="text-xs font-medium text-brand-300">Powered by Innotel</span>
            </div>
            <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
              <span className="text-gradient">Subscribe to Zeus</span>
            </h1>
            <p className="mx-auto mt-6 max-w-xl text-lg text-white/55">
              Pick your plan, get your number, and start calling in minutes.
              Add AI voice agents whenever you want them.
            </p>
          </div>
        </div>
      </section>

      {/* Plans */}
      <section className="border-t border-white/[0.06] bg-ink-900/50">
        <div className="mx-auto max-w-7xl px-5 py-16 sm:px-8">
          <div className="mx-auto grid max-w-4xl gap-8 sm:grid-cols-2">
            {plans.map((plan, i) => (
              <div
                key={plan.id}
                className={`card-surface relative flex flex-col rounded-2xl p-8 ${i === 1 ? "ring-glow" : ""}`}
              >
                {plan.badge ? (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-brand-500 px-4 py-0.5 text-xs font-semibold text-white">
                    {plan.badge}
                  </div>
                ) : null}
                <div className="mb-6">
                  <h2 className="text-xl font-semibold text-white">{plan.name}</h2>
                  <p className="mt-1 text-sm text-white/45">{plan.tagline}</p>
                  <div className="mt-4 flex items-baseline gap-2">
                    <span className="text-4xl font-bold text-white">${plan.priceMonthly}</span>
                    <span className="text-white/40">/month</span>
                    {plan.priceYearly ? (
                      <span className="ml-2 text-xs text-white/35">or ${plan.priceYearly}/year</span>
                    ) : null}
                  </div>
                </div>
                <ul className="mb-8 flex-1 space-y-3">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-center gap-2 text-sm text-white/70">
                      <CheckCircleIcon size={16} className="shrink-0 text-mint-400" />
                      {f}
                    </li>
                  ))}
                </ul>
                {plan.cta.external ? (
                  <a href={plan.cta.href} className="btn-primary w-full py-2.5 text-sm">
                    {plan.cta.label}
                    <ArrowRightIcon size={15} />
                  </a>
                ) : (
                  <Link href={plan.cta.href} className="btn-primary w-full py-2.5 text-sm">
                    {plan.cta.label}
                  </Link>
                )}
              </div>
            ))}
          </div>

          {/* Billing boundary, stated plainly: one membership, one invoice. */}
          <div className="mx-auto mt-12 max-w-4xl">
            <div className="card-surface rounded-2xl p-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-600/15">
                    <CreditCardIcon size={17} className="text-brand-300" />
                  </span>
                  <div>
                    <h3 className="text-sm font-semibold text-white">One bill for every Innotel service</h3>
                    <p className="mt-1 max-w-xl text-sm text-white/45">
                      Subscriptions are billed by Magnate, our billing platform. Voice
                      agents are added to that membership; the phone plan is set up in
                      this portal. Manage or cancel anything from one place.
                    </p>
                  </div>
                </div>
                <a href={MAGNATE_URL} className="btn-ghost px-5 py-2.5 text-sm">
                  Manage subscription
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Included with every plan */}
      <section className="border-t border-white/[0.06]">
        <div className="mx-auto max-w-7xl px-5 py-16 sm:px-8">
          <h2 className="text-center text-2xl font-bold tracking-tight">
            Included with every plan
          </h2>
          <div className="mt-10 grid gap-6 sm:grid-cols-3">
            <Included
              icon={<PhoneIcon size={20} className="text-brand-300" />}
              title="Your own number"
              text="A real phone number for calls and SMS, plus a softphone extension on every device."
            />
            <Included
              icon={<CheckCircleIcon size={20} className="text-mint-400" />}
              title="Voicemail & AI summaries"
              text="Transcribed voicemail with a summary, delivered to your inbox or read online."
            />
            <Included
              icon={<CreditCardIcon size={20} className="text-sun-400" />}
              title="Cancel anytime"
              text="Change or cancel your plan from the account portal — no contracts, no exit fees."
            />
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-white/[0.06] bg-ink-900/50">
        <div className="mx-auto max-w-7xl px-5 py-16 text-center sm:px-8">
          <h2 className="text-2xl font-bold tracking-tight">Questions before you subscribe?</h2>
          <p className="mx-auto mt-3 max-w-lg text-white/45">
            Everything else we run is billed the same way — see the full membership
            for voice, media, mail, storage and more.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <a href={SUBSCRIBE_URL} className="btn-primary px-7 py-3 text-sm">
              See all plans
              <ArrowRightIcon size={16} />
            </a>
            <Link href="/" className="btn-ghost px-7 py-3 text-sm">
              What Zeus does
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-white/[0.06] py-10">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-5 sm:px-8">
          <Logo size="sm" />
          <p className="text-xs text-white/30">
            &copy; {new Date().getFullYear()} Zeus VOIP Platform. Powered by Innotel.
          </p>
        </div>
      </footer>
    </div>
  );
}

function Included({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="card-surface rounded-2xl p-6">
      <span className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-white/[0.05]">
        {icon}
      </span>
      <h3 className="text-base font-semibold text-white">{title}</h3>
      <p className="mt-2 text-sm text-white/45">{text}</p>
    </div>
  );
}
