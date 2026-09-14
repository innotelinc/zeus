import type { Metadata } from "next";
import { headers } from "next/headers";
import { Logo } from "@/components/Logo";
import { SubscribeLanding } from "@/components/SubscribeLanding";
import { PhoneIcon, MessageIcon, FaxIcon, VoicemailIcon, CheckCircleIcon, ArrowRightIcon } from "@/components/icons";
import { ssoLoginEnabled } from "@/lib/oidc";
import { subscribeCatalog, subscribeOrigin } from "@/lib/catalog";

/**
 * Sign-in entrypoint — straight to Authentik when SSO is the offered path.
 *
 * Must be rendered as a plain <a>: this is a route handler that 302s to
 * Authentik's HTML sign-in page, and a next/link soft navigation cannot parse a
 * cross-origin HTML document as an RSC payload — the click simply did nothing.
 * The same rule applies to /api/auth/logout.
 */
function signInHref(path = ""): string {
  if (ssoLoginEnabled()) {
    return "/api/auth/authentik/login" + (path ? `?next=${encodeURIComponent(path)}` : "");
  }
  return "/login" + path;
}

const BRAND_NAME = process.env.NEXT_PUBLIC_BRAND_NAME ?? "Zeus";

/**
 * The subscribe host serves the subscription page as `/`, so it needs the
 * subscription title — without this the tab, link previews and search results
 * all advertised the marketing page instead.
 */
export async function generateMetadata(): Promise<Metadata> {
  const host = (await headers()).get("host") ?? "";
  if (!host.toLowerCase().startsWith("subscribe.")) return {};
  return {
    title: `Subscribe to ${BRAND_NAME} — Voice, SMS, fax and AI voice agents`,
    description: `Pick your ${BRAND_NAME} plan, get your phone number, and start calling in minutes. AI voice agents are available as an add-on.`,
  };
}

/** Everything but the subscription page, which the subscribe.* origin serves. */
export default async function LandingPage() {
  // subscribe.<domain> is the same portal on a second hostname: the marketing
  // page is for visitors, the subscription page is for buyers, and they are
  // served by one deployment so there is no second build to keep in sync.
  const host = (await headers()).get("host") ?? "";
  if (host.toLowerCase().startsWith("subscribe.")) {
    return <SubscribeLanding />;
  }

  // Pricing has one home — subscribe.<domain> — so every CTA here links to the
  // subscription origin instead of a `/subscribe` path on this marketing host.
  const subscribeHref = subscribeOrigin(host);

  const { phone, agents } = subscribeCatalog();

  return (
    <div className="min-h-screen bg-ink-950">
      {/* Nav */}
      <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-ink-950/85 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 sm:px-8">
          <Logo size="sm" />
          <div className="flex items-center gap-4">
            <a href={subscribeHref} className="text-sm font-medium text-white/60 transition hover:text-white">
              Pricing
            </a>
            <a href={signInHref()} className="text-sm font-medium text-white/60 transition hover:text-white">
              Sign in
            </a>
            <a href={subscribeHref} className="btn-primary px-5 py-2 text-sm">
              Get started
              <ArrowRightIcon size={15} />
            </a>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-grid" />
        <div className="relative mx-auto max-w-7xl px-5 pb-20 pt-20 sm:px-8 sm:pb-28 sm:pt-28">
          <div className="mx-auto max-w-3xl text-center">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-brand-500/30 bg-brand-500/10 px-4 py-1.5">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-mint-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-mint-400" />
              </span>
              <span className="text-xs font-medium text-brand-300">
                Powered by Innotel
              </span>
            </div>
            <h1 className="text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
              <span className="text-gradient">VoIP made simple.</span>
            </h1>
            <p className="mx-auto mt-6 max-w-xl text-lg text-white/55">
              Phone numbers, SMS, fax and voicemail for everyone — plus AI voice
              agents that answer your calls. One platform, one bill, no jargon.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
              <a href={subscribeHref} className="btn-primary min-w-[180px] px-8 py-3 text-base">
                See plans
                <span className="ml-1 text-xs font-normal text-white/60">
                  from ${phone.priceMonthly}/mo
                </span>
              </a>
              <a href={signInHref()} className="btn-ghost min-w-[180px] px-8 py-3 text-base">
                Sign in
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="border-t border-white/[0.06] bg-ink-900/50">
        <div className="mx-auto max-w-7xl px-5 py-20 sm:px-8">
          <div className="mb-14 text-center">
            <h2 className="text-3xl font-bold tracking-tight">
              Everything you need to communicate
            </h2>
            <p className="mt-3 text-white/45">
              Voice, SMS, fax, and voicemail — unified in one platform.
            </p>
          </div>

          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            <FeatureCard
              icon={<PhoneIcon size={28} className="text-brand-400" />}
              title="Voice"
              desc="Crystal-clear HD calling on your own number, with a softphone extension for every device you use."
            />
            <FeatureCard
              icon={<MessageIcon size={28} className="text-mint-400" />}
              title="SMS &amp; MMS"
              desc="Full messaging UI with conversations, contacts, and message history. Text from any device."
            />
            <FeatureCard
              icon={<FaxIcon size={28} className="text-sun-400" />}
              title="Fax"
              desc="Send and receive faxes digitally, with email-to-fax and a web interface."
            />
            <FeatureCard
              icon={<VoicemailIcon size={28} className="text-brand-300" />}
              title="Voicemail"
              desc="Voicemail with transcription and AI summaries. Listen online or get messages delivered to your email."
            />
          </div>
        </div>
      </section>

      {/* Plans — one phone plan for everyone, plus the voice-agents add-on. */}
      <section className="border-t border-white/[0.06]">
        <div className="mx-auto max-w-7xl px-5 py-20 sm:px-8">
          <div className="mb-14 text-center">
            <h2 className="text-3xl font-bold tracking-tight">
              Simple pricing
            </h2>
            <p className="mt-3 text-white/45">
              One phone plan for everyone, and AI voice agents if you want them.
              No hidden fees.
            </p>
          </div>

          <div className="mx-auto grid max-w-3xl gap-8 sm:grid-cols-2">
            {/* Phone plan */}
            <div className="card-surface relative flex flex-col rounded-2xl p-8">
              <div className="mb-6">
                <h3 className="text-xl font-semibold text-white">Phone</h3>
                <p className="mt-1 text-sm text-white/45">Everything you need to talk, text and fax</p>
                <div className="mt-4">
                  <span className="text-4xl font-bold text-white">${phone.priceMonthly}</span>
                  <span className="text-white/40">/month</span>
                </div>
              </div>
              <ul className="mb-8 flex-1 space-y-3">
                <PlanFeature text="Your own phone number" />
                <PlanFeature text="Softphone extension for every device" />
                <PlanFeature text="SMS messaging" />
                <PlanFeature text="Voicemail with transcription & AI summaries" />
                <PlanFeature text="Fax (send and receive)" />
              </ul>
              <a href={subscribeHref} className="btn-primary w-full py-2.5 text-sm">
                Get Phone
              </a>
            </div>

            {/* Capstone voice agents */}
            <div className="card-surface ring-glow relative flex flex-col rounded-2xl p-8">
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-brand-500 px-4 py-0.5 text-xs font-semibold text-white">
                {agents.badge ?? "Add-on"}
              </div>
              <div className="mb-6">
                <h3 className="text-xl font-semibold text-white">{agents.name}</h3>
                <p className="mt-1 text-sm text-white/45">{agents.tagline}</p>
                <div className="mt-4">
                  <span className="text-4xl font-bold text-white">${agents.priceMonthly}</span>
                  <span className="text-white/40">/month</span>
                </div>
              </div>
              <ul className="mb-8 flex-1 space-y-3">
                {agents.features.map((f) => (
                  <PlanFeature key={f} text={f} />
                ))}
              </ul>
              <a href={subscribeHref} className="btn-primary w-full py-2.5 text-sm">
                Add voice agents
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Voice agents deep dive */}
      <section className="border-t border-white/[0.06] bg-ink-900/50">
        <div className="mx-auto max-w-7xl px-5 py-20 sm:px-8">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div>
              <span className="inline-flex items-center gap-2 rounded-full border border-brand-500/30 bg-brand-500/10 px-3 py-1 text-xs font-medium text-brand-300">
                Capstone voice agents
              </span>
              <h2 className="mt-5 text-3xl font-bold tracking-tight">
                An agent that answers, so you don&apos;t have to
              </h2>
              <p className="mt-4 text-white/55">
                Voice agents built on Capstone pick up your calls, answer real
                questions, take messages and hand the call to you when it
                matters — on the same number you already own. Add them to your
                plan for ${agents.priceMonthly}/month.
              </p>
              <a href={subscribeHref} className="btn-primary mt-8 inline-flex px-8 py-3 text-base">
                See voice agents
                <ArrowRightIcon size={18} />
              </a>
            </div>
            <div className="card-surface rounded-2xl p-8">
              <h3 className="text-lg font-semibold text-white">What they handle</h3>
              <ul className="mt-5 space-y-3">
                {agents.features.map((f) => (
                  <PlanFeature key={f} text={f} />
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-white/[0.06]">
        <div className="mx-auto max-w-7xl px-5 py-20 text-center sm:px-8">
          <h2 className="text-3xl font-bold tracking-tight">
            Ready to get connected?
          </h2>
          <p className="mx-auto mt-3 max-w-lg text-white/45">
            Get your phone number, set up your extension, and start communicating in minutes.
          </p>
          <a href={subscribeHref} className="btn-primary mt-8 inline-flex px-8 py-3 text-base">
            Get started now
            <ArrowRightIcon size={18} />
          </a>
        </div>
      </section>

      {/* Footer */}
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

function FeatureCard({
  icon,
  title,
  desc,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <div className="card-surface card-surface-hover rounded-2xl p-6 text-center">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/[0.05]">
        {icon}
      </div>
      <h3 className="text-lg font-semibold text-white">{title}</h3>
      <p className="mt-2 text-sm text-white/45">{desc}</p>
    </div>
  );
}

function PlanFeature({ text }: { text: string }) {
  return (
    <li className="flex items-center gap-2 text-sm text-white/70">
      <CheckCircleIcon size={16} className="shrink-0 text-mint-400" />
      {text}
    </li>
  );
}
