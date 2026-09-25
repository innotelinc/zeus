import { requireDashboardUser } from "@/lib/dashboard-auth";
import { addonStatus } from "@/lib/addons";
import { dograhConfigured } from "@/lib/dograh";
import { loadVoiceConsole } from "@/lib/voice-console";
import { proxiedLaunchers } from "@/lib/console";
import AddonGate from "@/components/dashboard/AddonGate";
import VoiceSection from "@/components/dashboard/VoiceSection";

export const dynamic = "force-dynamic";

export const metadata = { title: "Voice Agents — Zeus" };

/**
 * The voice screen — Dograh, read directly.
 *
 * It used to be AVA's console: an agent list from AVA's admin API, capped by an
 * account-level "which agent answers my calls" mapping. Both of those are gone,
 * and the shape that replaced them is the shape the routing actually has:
 *
 *   * **An agent is a Dograh workflow.** It is authored in Dograh (this screen
 *     links there) and listed here with its real run count and its turn-taking
 *     settings.
 *   * **Which agent answers is a property of the number, not the account.**
 *     `voice_bindings` is the table the dialplan already renders from, so the
 *     selector below writes the same value the PBX will read.
 *
 * The gate is evaluated server-side so an unentitled account never receives the
 * console's markup (no flash of a paid screen), and it is the same
 * `addonStatus()` the routing path uses — a visible screen can never disagree
 * with what the PBX will do.
 */
export default async function VoicePage() {
  const user = await requireDashboardUser();
  const addon = await addonStatus("agents", { user: user.email });

  if (addon.state !== "enabled") {
    return <AddonGate sku="agents" state={addon.state} reason={addon.reason} />;
  }

  // The add-on is held; the *engine* is what is missing. That is a deployment
  // config state, not a billing lookup that could not be completed, so it is
  // rendered as one — the billing copy told a customer to retry something only
  // an administrator can change.
  if (!dograhConfigured()) {
    return (
      <AddonGate
        sku="agents"
        state="unknown"
        mode="deployment"
        reason="the voice engine is not configured on this deployment"
      />
    );
  }

  const capstone = await addonStatus("capstone", { user: user.email });
  const data = await loadVoiceConsole(user.id);

  // The products this screen hands off to, resolved server-side so the client
  // never reads the environment and a link the portal cannot address is never
  // rendered (see `proxiedLaunchers`).
  const launchers = proxiedLaunchers(["dograh", "capstone", "freepbx", "avantfax"]);

  return (
    <VoiceSection
      agents={data.agents}
      agentsState={data.agentsState}
      agentsError={data.agentsError}
      voice={data.voice}
      voiceError={data.voiceError}
      lines={data.lines}
      capstone={{ state: capstone.state, reason: capstone.reason }}
      launchers={launchers}
    />
  );
}
