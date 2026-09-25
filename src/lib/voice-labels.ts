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
