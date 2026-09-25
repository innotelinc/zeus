/**
 * The voice plane's vocabulary, in the operator's words.
 *
 * Split out of `lib/dograh.ts` because that module is a server client — it
 * reads `DOGRAH_API_KEY`, holds the engine's address, and must never be pulled
 * into a browser bundle — while these are pure strings a client component has
 * to render. Keeping them here means a component can name the engine's codes
 * without importing the client that talks to it.
 */

/**
 * How a call ended, in words an operator can act on.
 *
 * The engine's own codes are precise and entirely unhelpful on a screen
 * (`user_idle_max_duration_exceeded`). This does not replace them — the raw
 * value is what goes in a ticket — it front-runs them.
 */
export function describeOutcome(outcome: string | null): string {
  switch (outcome) {
    case null:
    case "":
      return "In progress";
    case "completed":
      return "Completed";
    case "user_idle_max_duration_exceeded":
      return "Caller went quiet and the call timed out";
    case "max_duration_exceeded":
    case "max_call_duration_exceeded":
      return "Hit the call time limit";
    case "user_hangup":
    case "caller_hangup":
      return "Caller hung up";
    case "agent_hangup":
    case "bot_hangup":
      return "Agent ended the call";
    case "failed":
    case "error":
      return "Failed";
    default:
      // Unknown codes are shown, not hidden: a new engine version inventing one
      // is information, and the alternative is a screen that says nothing.
      return outcome.replace(/_/g, " ");
  }
}

/**
 * Where a call moved to, in the operator's words.
 *
 * The stored token is dialplan vocabulary and is deliberately not renamed —
 * `[zeus-ai-return]` still records the leg as `ava`, because that is the
 * string the dialplan renders and the `voice_calls` rows already carry. What
 * changes on a screen is the *name*: the return leg is Dograh handing the
 * caller back, and that is what an operator should read.
 */
export function describeHandoffTarget(target: string): string {
  switch (target) {
    case "capstone":
      return "Capstone interview";
    case "operator":
      return "an operator";
    case "ava":
      return "Dograh";
    case "voicemail":
      return "voicemail";
    default:
      return target.replace(/_/g, " ");
  }
}

/** The path a call took, in the operator's words: `agent → Capstone interview`. */
export function describePath(handoffs: Array<{ to: string }>): string {
  if (handoffs.length === 0) return "no hand-off";
  return ["agent", ...handoffs.map((hop) => describeHandoffTarget(hop.to))].join(" → ");
}
