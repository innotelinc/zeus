import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-helpers";
import { addonStatus } from "@/lib/addons";
import { SPAN_KIND, withSpan, type Span } from "@/lib/otel";
import {
  dograhConfigured,
  getVoiceStack,
  getWorkflow,
  listWorkflows,
  type DograhTurnConfig,
  type DograhVoiceStack,
  type DograhWorkflow,
} from "@/lib/dograh";

export const dynamic = "force-dynamic";

/** One agent, as this screen needs it: the workflow plus how it takes turns. */
export interface AgentRow extends DograhWorkflow {
  turn: DograhTurnConfig | null;
}

/**
 * GET /api/voice/agents
 *
 * The agents this account may use — which is to say, Dograh's workflows.
 *
 * There is no create/delete here on purpose. An agent is a workflow, and a
 * workflow is a graph of prompts, tools and branching that belongs in the tool
 * built for editing it (`/dashboard/estate` links to it). A portal form that
 * produced a second, thinner kind of agent is exactly how this estate grew two
 * answers to "what is an agent".
 *
 * Reads are allowed even when the add-on check is inconclusive — an operator
 * needs to be able to see why calls are not being answered — but the response
 * always carries the add-on state so the UI never presents an unentitled agent
 * as usable.
 */
export async function GET(req: Request) {
  return withSpan("voice.agents.list", (span) => listAgents(req, span), {
    kind: SPAN_KIND.SERVER,
    attributes: { "http.route": "/api/voice/agents", "http.method": "GET" },
  });
}

async function listAgents(req: Request, span: Span): Promise<Response> {
  const { user, error } = await requireUser();
  if (error) return error;

  const addon = await addonStatus("agents", { user: user.email });
  span.setAttribute("zeus.addon.agents", addon.state);

  if (!dograhConfigured()) {
    return NextResponse.json({
      configured: false,
      addon: { state: addon.state, reason: addon.reason },
      agents: [],
      voice: null,
      error: "the voice engine is not configured on this deployment",
    });
  }

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const wanted = status === "active" || status === "archived" ? status : undefined;

  // The list and the voice stack are independent reads: a stack the engine
  // cannot describe must not blank the agent list, and vice versa.
  const [listResult, stackResult] = await Promise.all([
    listWorkflows(wanted),
    getVoiceStack(),
  ]);

  if (listResult.state !== "ok") {
    span.setStatus("error", listResult.error);
    return NextResponse.json({
      configured: true,
      addon: { state: addon.state, reason: addon.reason },
      agents: [],
      voice: null,
      error: listResult.error,
      state: listResult.state,
    });
  }

  // Turn-taking is per workflow and only in the detail payload. Twelve small
  // requests in parallel is cheaper than showing a screen that cannot say
  // whether an agent will talk over the caller — and a detail that fails
  // degrades to `null` rather than to a claim.
  const agents: AgentRow[] = await Promise.all(
    listResult.data.map(async (workflow) => {
      const detail = await getWorkflow(workflow.id);
      return {
        ...workflow,
        turn: detail.state === "ok" ? (detail.data.workflow_configurations ?? null) : null,
      };
    }),
  );

  const voice: DograhVoiceStack | null = stackResult.state === "ok" ? stackResult.data : null;

  return NextResponse.json({
    configured: true,
    addon: { state: addon.state, reason: addon.reason },
    agents,
    voice,
    state: "ok",
    // Reported beside the agents rather than instead of them: an operator can
    // still act on what loaded.
    voice_error: stackResult.state === "ok" ? null : stackResult.error,
  });
}
