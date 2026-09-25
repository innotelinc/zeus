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
 *
 * It also answers the drill-down's question — "which run is this call?" — from
 * the same vocabulary, so a per-call screen cannot invent a second way of
 * finding one.
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

export interface AgentList {
  agents: AgentRow[];
  /** `ok`, or why the agents could not be read. */
  state: string;
  error: string | null;
}

/**
 * The agents, with their turn-taking.
 *
 * Turn-taking is per workflow and only in the detail payload. Fetched in
 * parallel; a detail that fails degrades to `null` rather than to a claim about
 * how the agent behaves. A failure to list at all is carried as a state, never
 * thrown — an operator has to be able to tell "no agents" from "no engine".
 */
export async function loadAgents(): Promise<AgentList> {
  const workflows = await listWorkflows();
  if (workflows.state !== "ok") {
    return { agents: [], state: workflows.state, error: workflows.error };
  }

  const agents: AgentRow[] = await Promise.all(
    workflows.data.map(async (workflow) => {
      const detail = await getWorkflow(workflow.id);
      return {
        ...workflow,
        turn: detail.state === "ok" ? (detail.data.workflow_configurations ?? null) : null,
      };
    }),
  );
  return { agents, state: "ok", error: null };
}

export interface VoiceConsoleData {
  agents: AgentRow[];
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
  const { agents, state, error } = await loadAgents();

  if (state !== "ok") {
    return {
      agents: [],
      agentsState: state,
      agentsError: error,
      lines,
      runs: [],
      voice: null,
      voiceError: null,
    };
  }

  // A binding is stored as it appears in the dialplan — `[dograh-inbound]`'s
  // extension — which `capstone/scripts/sync_dograh_routes.py` publishes as
  // both the workflow's id and its name. Matching on either means an operator
  // who typed the id (the shape the PBX prints) still gets their calls joined.
  const runs = await runsForLines(agents, lines, runsPerAgent);
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

/**
 * The calls the workflows these lines reach have handled, newest first.
 *
 * `reached` is by *binding*: the engine's run list is estate-wide, and scoping
 * it here is what keeps one customer's screen off another's calls.
 */
export async function runsForLines(
  agents: AgentRow[],
  lines: InterviewLine[],
  runsPerAgent = 10,
): Promise<DograhRun[]> {
  const bound = lines
    .map((line) => line.capstone_binding)
    .filter((binding): binding is string => Boolean(binding));
  const reached = agents.filter(
    (agent) => bound.includes(String(agent.id)) || bound.includes(agent.name),
  );

  const runLists = await Promise.all(
    reached.map((agent) => listRuns(agent.id, { limit: runsPerAgent })),
  );
  return runLists
    .flatMap((result) => (result.state === "ok" ? result.data : []))
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
}

/** One workflow's run that carries a given portal call id. */
export interface RunMatch {
  agent: AgentRow;
  run: DograhRun;
}

/**
 * The engine run behind one call, by the id both products carry.
 *
 * The engine addresses a run by `(workflow, run)`, never by the portal's call
 * id, so finding one means asking each candidate workflow for its recent runs.
 * The agents are tried first when their name or id is the call's binding — that
 * is the workflow the dialplan sent the call to — and the scan is bounded so a
 * caller cannot make the portal walk an estate.
 *
 * A miss returns null, not a guess: "we looked and did not find it" is a fact
 * the drill-down renders, and a fabricated run would be worse than none.
 */
export async function findRunByCallId(
  callId: string,
  agents: AgentRow[],
  binding: string | null,
  perAgent = 100,
): Promise<RunMatch | null> {
  if (!callId) return null;

  const named = agents.filter(
    (agent) => binding === String(agent.id) || binding === agent.name,
  );
  const rest = agents.filter((agent) => !named.includes(agent));
  // The named workflow first (it is where the call was routed), then the rest
  // as a fallback for a binding that was changed after the call.
  for (const agent of [...named, ...rest]) {
    const result = await listRuns(agent.id, { limit: perAgent });
    if (result.state !== "ok") continue;
    const run = result.data.find((candidate) => candidate.call_id === callId);
    if (run) return { agent, run };
  }
  return null;
}
