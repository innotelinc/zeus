/**
 * The voice console's data, loaded in one place.
 *
 * Two owned screens read the same facts — `/dashboard/voice` (which agent
 * answers, and what is live) and `/dashboard/workflows` (the agents and their
 * calls) — and the estate's rule is one author per fact. This module is that
 * author: it reads Dograh's workflows and the account's own bindings, and
 * scopes the engine's estate-wide run list down to the workflows this account's
 * numbers actually reach.
 *
 * Scoping by *binding* and not by reading every run is deliberate: the engine's
 * run list is estate-wide, and handing all of it to one customer is how a
 * screen becomes a data leak.
 */
import {
  getWorkflow,
  getVoiceStack,
  listRuns,
  listWorkflows,
  type DograhRun,
  type DograhTurnConfig,
  type DograhVoiceStack,
  type DograhWorkflow,
} from "./dograh";
import { accountLines, type InterviewLine } from "./voice-bindings";

/** One agent, as the screens need it: the workflow plus how it takes turns. */
export interface AgentRow extends DograhWorkflow {
  turn: DograhTurnConfig | null;
}

export interface VoiceConsoleData {
  agents: AgentRow[];
  /** `ok`, or why the agents could not be read. */
  agentsState: string;
  agentsError: string | null;
  /** This account's numbers and the workflow each reaches. */
  lines: InterviewLine[];
  /** Recent calls, for the workflows these lines reach. */
  runs: DograhRun[];
  /** What the agents actually run on, read from the engine. */
  voice: DograhVoiceStack | null;
  voiceError: string | null;
}

/**
 * Load everything both voice screens show.
 *
 * A failure is carried as a state, never thrown: an operator has to be able to
 * tell "no agents" from "no engine", and the screens render the difference.
 */
export async function loadVoiceConsole(
  userId: string,
  runsPerAgent = 10,
): Promise<VoiceConsoleData> {
  const lines = accountLines(userId);
  const workflows = await listWorkflows();

  if (workflows.state !== "ok") {
    return {
      agents: [],
      agentsState: workflows.state,
      agentsError: workflows.error,
      lines,
      runs: [],
      voice: null,
      voiceError: null,
    };
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

  // A binding is stored as it appears in the dialplan — `[dograh-inbound]`'s
  // extension — which `capstone/scripts/sync_dograh_routes.py` publishes as
  // both the workflow's id and its name. Matching on either means an operator
  // who typed the id (the shape the PBX prints) still gets their calls joined.
  const bound = lines
    .map((line) => line.capstone_binding)
    .filter((binding): binding is string => Boolean(binding));
  const reached = agents.filter(
    (agent) => bound.includes(String(agent.id)) || bound.includes(agent.name),
  );

  const runLists = await Promise.all(
    reached.map((agent) => listRuns(agent.id, { limit: runsPerAgent })),
  );
  const runs: DograhRun[] = runLists
    .flatMap((result) => (result.state === "ok" ? result.data : []))
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));

  const stack = await getVoiceStack();

  return {
    agents,
    agentsState: "ok",
    agentsError: null,
    lines,
    runs,
    voice: stack.state === "ok" ? stack.data : null,
    voiceError: stack.state === "ok" ? null : stack.error,
  };
}
