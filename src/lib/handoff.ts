/**
 * Deciding which calls were handed off to Capstone.
 *
 * A hand-off is a routing event, not a transcript keyword, so this reads the
 * engine's own record of it: AVA reports the transfer destination it dialled
 * (`transfer_destination`) and the tool calls it made. Anything else — an
 * agent *saying* "I'll put you through to the interview team" and then hanging
 * up — is not a hand-off, and counting it as one would have operators chasing
 * calls Capstone never received.
 *
 * The destination is the dialplan extension defined in
 * pbx/asterisk/extensions_custom.conf ([zeus-ai-handoff]): 824 → Capstone's
 * interview agent. Keep this list in step with that context — it is the same
 * contract, read from the other side.
 */
import type { AvaCall, AvaCallRecord } from "./ava";

/** Hand-off destinations that mean "Capstone interview agent". */
export const CAPSTONE_DESTINATIONS = ["824", "capstone", "dograh"] as const;

export type HandoffDestination = "capstone" | null;

/**
 * Interpret a raw transfer destination.
 *
 * AVA reports whatever the agent dialled, which may be a bare extension
 * ("824"), a channel-ish form ("Local/824@zeus-ai-handoff"), or a context
 * reference. Match on the destination rather than the exact string, and
 * refuse to guess: an unrecognised destination is not a Capstone hand-off.
 */
export function classifyDestination(raw: unknown): HandoffDestination {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;

  for (const destination of CAPSTONE_DESTINATIONS) {
    // "824" must match "824", "Local/824@...", "SIP/824"; and "dograh"/
    // "capstone" may appear as a context or app name.
    const pattern = new RegExp(`(^|[/,@:])${destination}([/,@:]|$)`, "i");
    if (pattern.test(value)) return "capstone";
  }
  return null;
}

/** Pull a destination string out of a tool-call payload of unknown shape. */
function destinationFromToolCall(call: Record<string, unknown>): string | null {
  for (const key of ["destination", "target", "extension", "transfer_destination", "args"]) {
    const value = call[key];
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      const nested = value as Record<string, unknown>;
      for (const inner of ["destination", "target", "extension"]) {
        if (typeof nested[inner] === "string") return nested[inner] as string;
      }
    }
  }
  return null;
}

/**
 * True when the call actually reached Capstone.
 *
 * Requires positive evidence: a transfer destination the engine recorded, or
 * a transfer tool call naming one. A summary or outcome mentioning a transfer
 * is NOT enough on its own.
 */
export function isCapstoneHandoff(call: AvaCallRecord): boolean {
  if (classifyDestination(call.transfer_destination) === "capstone") return true;

  for (const toolCall of call.tool_calls ?? []) {
    const name = typeof toolCall.name === "string" ? toolCall.name : "";
    const looksLikeTransfer = /transfer|handoff|hand_off|forward/i.test(name);
    if (!looksLikeTransfer) continue;
    if (classifyDestination(destinationFromToolCall(toolCall)) === "capstone") {
      return true;
    }
  }
  return false;
}

/** Why a call is interesting enough to fetch its full record for. */
export function mightBeHandoff(call: AvaCall): boolean {
  const outcome = (call.outcome ?? "").toLowerCase();
  return outcome.includes("transfer") || outcome.includes("hand");
}

export interface HandoffRow {
  recordId: string;
  caller: string;
  startTime: string | null;
  durationSeconds: number | null;
  agent: string | null;
  /** Engine-measured average turn latency, the honest "how did it feel". */
  avgTurnLatencyMs: number | null;
  totalTurns: number | null;
  outcome: string | null;
}

export function toHandoffRow(record: AvaCallRecord): HandoffRow {
  return {
    recordId: record.record_id ?? record.id ?? "",
    caller: record.caller_number ?? record.caller_name ?? "Unknown caller",
    startTime: record.start_time ?? record.started_at ?? null,
    durationSeconds: record.duration_seconds ?? null,
    agent: record.agent_name ?? record.agent_slug ?? null,
    avgTurnLatencyMs: record.avg_turn_latency_ms ?? null,
    totalTurns: record.total_turns ?? null,
    outcome: record.outcome ?? null,
  };
}
