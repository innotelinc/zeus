import { requireDashboardUser } from "@/lib/dashboard-auth";
import { addonStatus } from "@/lib/addons";
import { accountLines } from "@/lib/voice-bindings";
import {
  dograhConfigured,
  getVoiceStack,
  getWorkflow,
  listRuns,
  listWorkflows,
  type DograhRun,
} from "@/lib/dograh";
import AddonGate from "@/components/dashboard/AddonGate";
import VoiceSection, { type AgentRow } from "@/components/dashboard/VoiceSection";

export const dynamic = "force-dynamic";

export const metadata = { title: "Voice Agents — Zeus" };

/** How many of an agent's calls the screen shows. */
const RUNS_PER_AGENT = 10;

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
 *     selector below writes the same value the PBX will read. One account can
 *     hold a support line and an interview line; an account-wide agent could
 *     not express that, which is why the concept is deleted rather than ported.
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
  // an administrator can change (see AddonGate's `mode`).
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

  const workflows = await listWorkflows();
  const lines = accountLines(user.id);
  const capstone = await addonStatus("capstone", { user: user.email });

  if (workflows.state !== "ok") {
    // A reachable-but-unreadable engine is its own state, and it is not
    // "no agents": an operator has to be able to tell quiet from broken.
    return (
      <VoiceSection
        agents={[]}
        agentsState={workflows.state}
        agentsError={workflows.error}
        voice={null}
        lines={lines}
        runs={[]}
        capstone={{ state: capstone.state, reason: capstone.reason }}
      />
    );
  }

  // Turn-taking is per workflow and only in the detail payload. Fetched in
  // parallel; a detail that fails degrades to `null` rather than to a claim
  // about how the agent behaves.
  const agents: AgentRow[] = await Promise.all(
    workflows.data.map(async (workflow) => {
      const detail = await getWorkflow(workflow.id);
      return {
        ...workflow,
        turn: detail.state === "ok" ? (detail.data.workflow_configurations ?? null) : null,
      };
    }),
  );

  // The calls the agent handled, for the agents this account's lines reach.
  // Scoped by *binding*, not by reading every workflow's runs: the engine's run
  // list is estate-wide, and handing it to one customer is how a screen becomes
  // a data leak.
  const bound = lines
    .map((line) => line.capstone_binding)
    .filter((binding): binding is string => Boolean(binding));
  // A binding is stored as it appears in the dialplan — `[dograh-inbound]`'s
  // extension — which `capstone/scripts/sync_dograh_routes.py` publishes as
  // both the workflow's id and its name. Matching on either means an operator
  // who typed the id (the shape the PBX prints) still gets their calls joined.
  const reached = agents.filter(
    (agent) => bound.includes(String(agent.id)) || bound.includes(agent.name),
  );
  const runLists = await Promise.all(
    reached.map((agent) => listRuns(agent.id, { limit: RUNS_PER_AGENT })),
  );
  const runs: DograhRun[] = runLists
    .flatMap((result) => (result.state === "ok" ? result.data : []))
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));

  const stack = await getVoiceStack();

  return (
    <VoiceSection
      agents={agents}
      agentsState="ok"
      agentsError={null}
      voice={stack.state === "ok" ? stack.data : null}
      voiceError={stack.state === "ok" ? null : stack.error}
      lines={lines}
      runs={runs}
      capstone={{ state: capstone.state, reason: capstone.reason }}
    />
  );
}

