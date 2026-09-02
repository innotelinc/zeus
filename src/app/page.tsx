import Link from "next/link";
import { Logo } from "@/components/Logo";
import { PhoneIcon, MessageIcon, FaxIcon, VoicemailIcon, CheckCircleIcon, ArrowRightIcon } from "@/components/icons";

/** SSO entrypoint — goes straight to Authentik when configured. */
function signInHref(path = ""): string {
  const oidcEnabled = Boolean(
    process.env.AUTHENTIK_ISSUER_URL &&
      process.env.AUTHENTIK_CLIENT_ID &&
      process.env.AUTHENTIK_CLIENT_SECRET,
  );
  if (oidcEnabled) {
    return "/api/auth/authentik/login" + (path ? `?next=${encodeURIComponent(path)}` : "");
  }
  return "/login" + path;
}

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-ink-950">
      {/* Nav */}
      <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-ink-950/85 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 sm:px-8">
          <Logo size="sm" />
          <div className="flex items-center gap-4">
            <Link href={signInHref()} className="text-sm font-medium text-white/60 transition hover:text-white">
              Sign in
            </Link>
            <Link href={signInHref("/dashboard")} className="btn-primary px-5 py-2 text-sm">
              Get started
              <ArrowRightIcon size={15} />
            </Link>
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
                Powered by VoIP.ms &amp; FreePBX
              </span>
            </div>
            <h1 className="text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
              <span className="text-gradient">Business VoIP</span>
              <br />
              <span className="text-white">made simple.</span>
            </h1>
            <p className="mx-auto mt-6 max-w-xl text-lg text-white/55">
              Get phone numbers, SMS, fax, and voicemail — all in one platform.
              Consumer and business plans available. Sign up in minutes.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
              <Link
                href={signInHref("/dashboard")}
                className="btn-primary min-w-[180px] px-8 py-3 text-base"
              >
                Consumer Plan
                <span className="ml-1 text-xs font-normal text-white/60">$19.99/mo</span>
              </Link>
              <Link
                href={signInHref("/dashboard")}
                className="btn-ghost min-w-[180px] px-8 py-3 text-base"
              >
                Business Plan
                <span className="ml-1 text-xs font-normal text-white/45">$49.99/mo</span>
              </Link>
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
              desc="Business phone numbers with crystal-clear HD voice. FreePBX extensions for your whole team."
            />
            <FeatureCard
              icon={<MessageIcon size={28} className="text-mint-400" />}
              title="SMS &amp; MMS"
              desc="Full messaging UI with conversations, contacts, and message history. Text from any device."
            />
            <FeatureCard
              icon={<FaxIcon size={28} className="text-sun-400" />}
              title="Fax"
              desc="Send and receive faxes digitally. AvantFax integration with email-to-fax and web interface."
            />
            <FeatureCard
              icon={<VoicemailIcon size={28} className="text-brand-300" />}
              title="Voicemail"
              desc="Voicemail with transcription and AI summaries. Listen online or get messages delivered to your email."
            />
          </div>
        </div>
      </section>

      {/* Plans */}
      <section className="border-t border-white/[0.06]">
        <div className="mx-auto max-w-7xl px-5 py-20 sm:px-8">
          <div className="mb-14 text-center">
            <h2 className="text-3xl font-bold tracking-tight">
              Choose your plan
            </h2>
            <p className="mt-3 text-white/45">
              Simple pricing. No hidden fees.
            </p>
          </div>

          <div className="mx-auto grid max-w-3xl gap-8 sm:grid-cols-2">
            {/* Consumer */}
            <div className="card-surface relative flex flex-col rounded-2xl p-8">
              <div className="mb-6">
                <h3 className="text-xl font-semibold text-white">Consumer</h3>
                <p className="mt-1 text-sm text-white/45">Perfect for personal use</p>
                <div className="mt-4">
                  <span className="text-4xl font-bold text-white">$19.99</span>
                  <span className="text-white/40">/month</span>
                </div>
              </div>
              <ul className="mb-8 flex-1 space-y-3">
                <PlanFeature text="1 phone number" />
                <PlanFeature text="VoIP.ms DID" />
                <PlanFeature text="FreePBX extension" />
                <PlanFeature text="SMS messaging" />
                <PlanFeature text="Voicemail with transcription & AI summaries" />
                <PlanFeature text="Basic fax (1 page/mo)" />
              </ul>
              <Link
                href={signInHref("/dashboard")}
                className="btn-primary w-full py-2.5 text-sm"
              >
                Get Consumer
              </Link>
            </div>

            {/* Business */}
            <div className="card-surface ring-glow relative flex flex-col rounded-2xl p-8">
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-brand-500 px-4 py-0.5 text-xs font-semibold text-white">
                Most Popular
              </div>
              <div className="mb-6">
                <h3 className="text-xl font-semibold text-white">Business</h3>
                <p className="mt-1 text-sm text-white/45">For teams and companies</p>
                <div className="mt-4">
                  <span className="text-4xl font-bold text-white">$49.99</span>
                  <span className="text-white/40">/month</span>
                </div>
              </div>
              <ul className="mb-8 flex-1 space-y-3">
                <PlanFeature text="Up to 5 phone numbers" />
                <PlanFeature text="VoIP.ms DIDs" />
                <PlanFeature text="Multiple FreePBX extensions" />
                <PlanFeature text="SMS on all numbers" />
                <PlanFeature text="Voicemail with transcription & AI summaries" />
                <PlanFeature text="Full fax (unlimited pages)" />
                <PlanFeature text="Call history & recordings" />
                <PlanFeature text="Priority support" />
              </ul>
              <Link
                href={signInHref("/dashboard")}
                className="btn-primary w-full py-2.5 text-sm"
              >
                Get Business
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-white/[0.06] bg-ink-900/50">
        <div className="mx-auto max-w-7xl px-5 py-20 text-center sm:px-8">
          <h2 className="text-3xl font-bold tracking-tight">
            Ready to get connected?
          </h2>
          <p className="mx-auto mt-3 max-w-lg text-white/45">
            Get your phone number, set up your extension, and start communicating in minutes.
          </p>
          <Link
            href={signInHref("/dashboard")}
            className="btn-primary mt-8 inline-flex px-8 py-3 text-base"
          >
            Get started now
            <ArrowRightIcon size={18} />
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/[0.06] py-10">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-5 sm:px-8">
          <Logo size="sm" />
          <p className="text-xs text-white/30">
            &copy; {new Date().getFullYear()} Zeus VOIP Platform. Powered by VoIP.ms, FreePBX &amp; AvantFax.
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