import { requireDashboardUser } from "@/lib/dashboard-auth";
import { addonStatus } from "@/lib/addons";
import db from "@/lib/db";
import {
  avaConfigured,
  listAgents,
  listCalls,
  type AvaAgent,
  type AvaCall,
} from "@/lib/ava";
import AddonGate from "@/components/dashboard/AddonGate";
import VoiceSection from "@/components/dashboard/VoiceSection";

export const dynamic = "force-dynamic";

interface MappingRow {
  agent_slug: string;
}

/**
 * The gate is evaluated server-side so an unentitled account never receives
 * the console's markup (no flash of a paid screen), and the same
 * addonStatus() the routing path uses decides it — a visible screen can
 * never disagree with what the PBX will do.
 */
export default async function VoicePage() {
  const user = await requireDashboardUser();
  const addon = await addonStatus("agents", { user: user.email });

  if (addon.state !== "enabled") {
    return <AddonGate sku="agents" state={addon.state} reason={addon.reason} />;
  }

  const mapping = db
    .prepare("SELECT agent_slug FROM voice_agents WHERE user_id = ?")
    .get(user.id) as MappingRow | undefined;

  if (!avaConfigured()) {
    return (
      <AddonGate
        sku="agents"
        state="unknown"
        reason="the voice engine is not configured on this deployment"
      />
    );
  }

  const [agentResult, callResult] = await Promise.all([listAgents(), listCalls(25)]);

  const agents: AvaAgent[] = agentResult.state === "ok" ? agentResult.data : [];
  const calls: AvaCall[] = callResult.state === "ok" ? callResult.data.calls : [];
  const avaState = agentResult.state !== "ok" ? agentResult.state : callResult.state;

  return (
    <VoiceSection
      agents={agents}
      calls={calls}
      mappedAgent={mapping?.agent_slug ?? null}
      avaState={avaState}
    />
  );
}
