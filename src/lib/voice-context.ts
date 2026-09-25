/**
 * The read side of the call-context envelope.
 *
 * (Design notes live in docs/unified-console.md and, historically,
 * docs/voice-convergence.md D2.)
 *
 * The dialplan stamps the channel once, at ingress, with the small facts both
 * agents need (AI_CALL_ID, AI_ACCOUNT, AI_AGENT, the caller, the Capstone
 * binding) and with `AI_CONTEXT_TOKEN=${UNIQUEID}` — a handle for everything
 * else. This module is what that handle resolves to: account, plan, prior
 * calls, and a transcript handle.
 *
 * Two things about it are deliberate:
 *
 *   1. **The token is a pointer, not a secret.** `${UNIQUEID}` is timestamp-
 *      based and guessable, so it is never the guard: the caller must present
 *      `VOICE_CONTEXT_SECRET` (the credential Capstone and the engine hold),
 *      and an unset secret refuses every read rather than opening the route.
 *      That is also why the channel carries no account id inside the token.
 *   2. **A call is readable while it is live, and for five minutes after.**
 *      The hand-off itself is the reason for the window: the answering agent's
 *      session ends when the channel leaves Stasis, so at the moment the next
 *      system answers, the call is *just* over — the grace is what makes the
 *      hand-off fetchable. The hand-back is the same channel returning (so the
 *      same token), which is live again by the time it asks. Outside the window
 *      the context is not served: a call id that stays readable forever is a
 *      call id that can be replayed by anyone who read a log.
 *
 * Where the facts come from, in order: the live channel through AMI (the
 * envelope the dialplan stamped, authoritative while the channel exists), then
 * this portal's own `voice_calls` store, which the switch fills from AMI events
 * and which answers after a hangup. Neither source is an agent: a call no agent
 * picked up is still a call this platform routed, and both sources know it.
 */
import crypto from "crypto";
import { normalizeDid } from "./dialplan-values";
import { getAmiClient } from "./ami";
import { getVoiceCall, priorCallsForDid } from "./voice-calls";
import db from "./db";
import { cachedAddonDecision } from "./addon-cache";

/**
 * How long a finished call stays readable. Five minutes covers the two reads
 * that matter — Capstone at the hand-off (seconds after AVA's session ends)
 * and AVA at the hand-back — without leaving call ids replayable for a day.
 * Not an env var on purpose: it is a policy with a stated reason, and a
 * deployment that disagrees should change this line and the doc together.
 */
export const CONTEXT_GRACE_MS = 5 * 60 * 1000;

/** The add-on row that says an account may reach Capstone at all. */
export const CAPSTONE_ADDON = "capstone";


/** What the dialplan reads off the channel its envelope was stamped on. */
const ENVELOPE_VARS = [
  "AI_ACCOUNT",
  "AI_AGENT",
  "FROM_DID",
  "AI_CALLER_NUM",
  "AI_CALLER_NAME",
  "AI_CALL_ID",
  "ZEUS_RETURN_OUTCOME",
] as const;

export type ContextAuth = "ok" | "unconfigured" | "unauthorized";

export function contextSecret(): string {
  return (process.env.VOICE_CONTEXT_SECRET ?? "").trim();
}

/**
 * Authorise a context read.
 *
 * "unconfigured" is its own answer, not a 401: with no secret set there is
 * nothing to compare against, and the only safe reading of that is "this
 * deployment has not turned the route on" — which the caller is told, rather
 * than being told its credential is wrong.
 */
export function authorizeContextRead(req: Request): ContextAuth {
  const secret = contextSecret();
  if (!secret) return "unconfigured";

  const header = req.headers.get("authorization") ?? "";
  const presented = header.toLowerCase().startsWith("bearer ")
    ? header.slice("bearer ".length).trim()
    : "";

  if (!presented) return "unauthorized";
  // Timing-safe, and length-checked first: timingSafeEqual throws on a length
  // mismatch, which would turn a wrong-length credential into a 500.
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return "unauthorized";
  return "ok";
}

/**
 * Asterisk channel ids / uniqueids (`1758500000.1234`), plus the channel-name
 * form AMI also accepts. The token is passed into an AMI action, so the
 * charset is pinned rather than "anything that is not a slash".
 */
export function isCallToken(value: string): boolean {
  return /^[A-Za-z0-9._-]{4,64}$/.test(value);
}

// `normalizeDid` moved to ./dialplan-values (with the Capstone target's rule)
// so the rule can be exercised on its own, without importing this module's
// AMI/database dependencies. Re-exported, so existing callers keep
// importing it from here.
export { normalizeDid };

export interface CallFacts {
  call_id: string;
  /**
   * Always null. It was the voice engine's record id — the key into that
   * engine's transcript store. With one engine there is no second transcript
   * store and so no second id; the transcript is the answering engine's, and
   * `capstone_transcript` carries the handle the portal actually holds (the
   * call id plus the workflow). Kept in the shape so callers do not have to
   * change in the same release.
   */
  record_id: string | null;
  /** The number the caller dialled — what names the account. */
  did: string | null;
  agent: string | null;
  /** The portal account id, when the channel's envelope carried one. */
  account_id: string | null;
  caller_number: string | null;
  caller_name: string | null;
  started_at: string | null;
  ended_at: string | null;
  /** True while Asterisk still carries the channel. */
  live: boolean;
  /** Which source answered, so a caller can see how it was resolved. */
  source: "channel" | "record";
  /** Set by the shared-plane interview hand-back, if the channel is still live. */
  return_outcome: string | null;
}

/**
 * Is this call inside its readable window?
 *
 * `live` short-circuits, and an unparseable or missing end time does NOT: a
 * record we cannot date is one we cannot say is recent, so it fails closed.
 */
export function isWithinContextWindow(facts: CallFacts, now: number = Date.now()): boolean {
  if (facts.live) return true;
  if (!facts.ended_at) return false;
  const ended = Date.parse(facts.ended_at);
  if (Number.isNaN(ended)) return false;
  return now - ended <= CONTEXT_GRACE_MS;
}

// ── resolution ────────────────────────────────────────────────────

/**
 * A lookup's outcome, kept three-valued so the route can answer honestly.
 *
 * "none" (we looked and this call is not ours) and "unavailable" (we could not
 * look) are different operator problems and different status codes; a route
 * that collapses them reports a broken AMI connection as an unknown call,
 * which is exactly how a working system gets debugged in the wrong place.
 */
export type Lookup =
  | { state: "found"; facts: CallFacts }
  | { state: "none" }
  | { state: "unavailable"; reason: string };

function clean(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed || trimmed === "(null)" || trimmed === "unset") return null;
  return trimmed;
}

async function getvar(
  client: ReturnType<typeof getAmiClient>,
  channel: string,
  variable: string,
): Promise<string | null> {
  const response = await client.sendAction({
    Action: "Getvar",
    Channel: channel,
    Variable: variable,
  });
  // A missing variable answers `Response: Error` (or `Value: (null)`), and a
  // channel that no longer exists answers Error too — both mean "no fact".
  if ((response.Response ?? "").toLowerCase() !== "success") return null;
  return clean(response.Value);
}

/**
 * The envelope, off the live channel. This is the authoritative source while
 * the call is up: it is what this call's own dialplan stamped, and it needs no
 * join to name the account.
 */
async function channelFacts(token: string): Promise<Lookup> {
  const client = getAmiClient();
  if (!client.isConnected) {
    return {
      state: "unavailable",
      reason:
        "AMI is not connected on this deployment (ASTERISK_AMI_* unset, or the PBX is unreachable)",
    };
  }

  let values: Record<string, string | null>;
  try {
    const pairs = await Promise.all(
      ENVELOPE_VARS.map(async (name) => [name, await getvar(client, token, name)] as const),
    );
    values = Object.fromEntries(pairs);
  } catch (e) {
    return { state: "unavailable", reason: e instanceof Error ? e.message : "AMI request failed" };
  }

  // The envelope's own marker: a channel carrying none of these never went
  // through the dialplan's account context, so it is not a call we have context
  // for.
  if (!values.AI_ACCOUNT && !values.FROM_DID && !values.AI_AGENT) return { state: "none" };

  return {
    state: "found",
    facts: {
      call_id: values.AI_CALL_ID ?? token,
      record_id: null,
      did: normalizeDid(values.FROM_DID),
      agent: values.AI_AGENT,
      account_id: values.AI_ACCOUNT,
      caller_number: values.AI_CALLER_NUM,
      caller_name: values.AI_CALLER_NAME,
      started_at: null,
      ended_at: null,
      live: true,
      source: "channel",
      return_outcome: values.ZEUS_RETURN_OUTCOME,
    },
  };
}

/**
 * This portal's own store for the call, as `CallFacts`.
 *
 * Keyed on `call_id`, which is the channel's own id and therefore what the
 * token is. A row this portal never wrote is not a call it routed, so a miss
 * returns null rather than a synthesised record — the distinction
 * `resolveCallFacts` turns into "not one of ours".
 */
function storedFacts(token: string): CallFacts | null {
  const row = getVoiceCall(token);
  if (!row) return null;

  return {
    call_id: row.call_id,
    record_id: null,
    did: normalizeDid(row.did),
    agent: null,
    account_id: row.account_id ?? null,
    // The switch records the number it was asked to serve, not who asked; the
    // caller's own number is not a column this table keeps.
    caller_number: null,
    caller_name: null,
    started_at: row.started_at ?? null,
    ended_at: row.ended_at ?? null,
    live: !row.ended_at,
    source: "record",
    return_outcome: row.disposition ?? null,
  };
}

export interface CallResolution {
  lookup: Lookup;
  /**
   * Whether the local store could be read. There is no longer a remote record
   * list to scan, so this is the whole of what a caller needs to tell "no prior
   * calls" apart from "could not look" — see `priorCallsFor`.
   */
  storeReadable: boolean;
}

/**
 * The call, from the first source that has it.
 *
 * The live channel is tried first because it is the envelope this call's own
 * dialplan wrote; this portal's `voice_calls` store is the fallback, and it is
 * what answers after a hangup. Both are local, so "unavailable" now means the
 * channel could not be asked *and* the local read threw — one working source
 * that does not know the token means the call is not one of ours.
 */
export async function resolveCallFacts(token: string): Promise<CallResolution> {
  const channel = await channelFacts(token);
  if (channel.state === "found") return { lookup: channel, storeReadable: true };

  let stored: CallFacts | null = null;
  try {
    stored = storedFacts(token);
  } catch (error) {
    return {
      lookup: {
        state: "unavailable",
        reason: `channel: ${channel.state === "unavailable" ? channel.reason : "token not found"}; store: ${describeError(error)}`,
      },
      storeReadable: false,
    };
  }

  if (stored) return { lookup: { state: "found", facts: stored }, storeReadable: true };

  // The store answered and did not know the token. That settles it: this is not
  // a call this platform routed.
  return { lookup: { state: "none" }, storeReadable: true };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── the account's half ────────────────────────────────────────────

export interface AccountContext {
  id: string;
  name: string;
  plan: string;
  plan_status: string;
}

export interface InterviewContext {
  /** Mirrors the routing renderer: a target without entitlement is not sent. */
  entitled: boolean;
  target: string | null;
}

interface AccountRow {
  id: string;
  name: string;
  plan: string;
  plan_status: string;
}

/**
 * Which account this call belongs to.
 *
 * The channel's AI_ACCOUNT is preferred because the dialplan wrote it for this
 * exact call; the DID join is the fallback for a call whose channel is gone.
 * An unentitled binding is dropped here for the same reason the write path
 * refuses to store one: the row that names a workflow must not
 * outlive the row that says the account may reach one.
 */
export function accountContextFor(facts: CallFacts): {
  account: AccountContext | null;
  interview: InterviewContext;
} {
  let row: AccountRow | undefined;

  if (facts.account_id) {
    row = db
      .prepare("SELECT id, name, plan, plan_status FROM users WHERE id = ?")
      .get(facts.account_id) as AccountRow | undefined;
  }
  if (!row && facts.did) {
    row = db
      .prepare(
        `SELECT u.id, u.name, u.plan, u.plan_status
           FROM users u
           JOIN phone_numbers pn ON pn.user_id = u.id
          WHERE pn.did = ?
          ORDER BY CASE pn.status WHEN 'active' THEN 0 ELSE 1 END
          LIMIT 1`,
      )
      .get(facts.did) as AccountRow | undefined;
  }

  if (!row) return { account: null, interview: { entitled: false, target: null } };

  // The last recorded decision. Read through the same module the writers use
  // (`./addon-cache`), so this reader cannot drift from them: `null` there means
  // "nothing has ever been asked", and this route treats that the same way the
  // dialplan renderer treats a missing row — not entitled.
  const entitled = cachedAddonDecision(row.id, CAPSTONE_ADDON) === true;

  let target: string | null = null;
  if (entitled && facts.did) {
    const binding = db
      .prepare("SELECT capstone_binding FROM voice_bindings WHERE user_id = ? AND did = ?")
      .get(row.id, facts.did) as { capstone_binding: string | null } | undefined;
    target = binding?.capstone_binding?.trim() || null;
  }

  return { account: row, interview: { entitled, target } };
}

export interface PriorCalls {
  count: number;
  last_at: string | null;
  last_record_id: string | null;
}

/**
 * What we know about this caller from previous calls.
 *
 * Read from this portal's own `voice_calls` store (see `priorCallsForDid`),
 * which the switch fills from AMI events — so a context read no longer depends
 * on a voice engine being reachable. A `null` return still means "not
 * knowable", which is a different answer from zero prior calls: the
 * distinction the voice screens make between "quiet" and "broken".
 */
export function priorCallsFor(facts: CallFacts, storeReadable: boolean): PriorCalls | null {
  if (!storeReadable) return null;
  // The number the caller dialled names this platform's side of the call, and
  // it is the only column `voice_calls` carries that describes the call's
  // destination. Without it there is nothing to match on.
  if (!facts.did) return { count: 0, last_at: null, last_record_id: null };

  const prior = priorCallsForDid(facts.did, facts.call_id);
  return {
    count: prior.count,
    last_at: prior.last_at,
    last_record_id: prior.last_call_id,
  };
}

export interface CallContext {
  call_id: string;
  did: string | null;
  agent: string | null;
  caller: { number: string | null; name: string | null };
  started_at: string | null;
  ended_at: string | null;
  live: boolean;
  return_outcome: string | null;
  resolved_from: CallFacts["source"];
  account: AccountContext | null;
  interview: InterviewContext;
  prior_calls: PriorCalls | null;
  /**
   * Always null, and deliberately so.
   *
   * This used to hand over the voice engine's record id, the key into that
   * engine's transcript store. With one engine there is no portal-side
   * transcript id to give: the transcript belongs to whoever answered, and the
   * honest handle for it is `capstone_transcript` below — the call id plus the
   * workflow, both of which this portal really holds. A field that always
   * returned an id this route had invented would be worse than one that says so.
   */
  transcript_handle: null;
  /**
   * The same call in **Capstone's** store, when the account is entitled to hand
   * off at all.
   *
   * There is no URL here because there cannot honestly be one: Capstone writes a
   * transcript per workflow *run* and addresses it with a signed public token it
   * mints at call time (its `GET /api/v1/public/download/workflow/<token>/transcript`),
   * which never passes through the portal. What the portal *does* hold is the key
   * both products already share — the call id — and the workflow the account's
   * number reaches, so an operator (or Capstone itself) can find the run from
   * those. Naming them is the handle; inventing a link that 404s would be worse
   * than none (§2.6: two transcripts, two truth stores).
   */
  capstone_transcript: { call_id: string; workflow: string } | null;
}

export function buildCallContext(facts: CallFacts, storeReadable: boolean): CallContext {
  const { account, interview } = accountContextFor(facts);
  return {
    call_id: facts.call_id,
    did: facts.did,
    agent: facts.agent,
    caller: { number: facts.caller_number, name: facts.caller_name },
    started_at: facts.started_at,
    ended_at: facts.ended_at,
    live: facts.live,
    return_outcome: facts.return_outcome,
    resolved_from: facts.source,
    account,
    interview,
    prior_calls: priorCallsFor(facts, storeReadable),
    transcript_handle: null,
    // Offered only beside a true entitlement and a configured target, the same
    // rule the dialplan and the renderer apply: an unentitled account has no
    // Capstone run to look up, and a target with no entitlement is not sent.
    capstone_transcript:
      interview.entitled && interview.target
        ? { call_id: facts.call_id, workflow: interview.target }
        : null,
  };
}
