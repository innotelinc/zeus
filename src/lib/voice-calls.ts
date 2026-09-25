/**
 * `voice_calls` — one row per call, one id across products (P4/D7 in
 * docs/voice-convergence.md).
 *
 * The id is Asterisk's `UNIQUEID`, which is also what the dialplan stamps on the
 * channel as `AI_CALL_ID` and `AI_CONTEXT_TOKEN`. That is deliberate: §2.6 of the
 * design is *two transcripts, two truth stores* — AVA has call records, Capstone
 * has workflow runs, and an operator asking "what happened on this call?" has to
 * know which product answered, and read both if the call moved between them.
 * This table is the join: one row, the id every product already carries.
 *
 * ## Who writes it, and why not the agents
 *
 * The **switch** writes it. `src/lib/ami-handler.ts` fills the row from the
 * channel's own events — the dialplan's envelope arrives as AMI `VarSet`, a
 * hand-off arrives as `Newexten` in Capstone's context — so neither agent has to
 * instrument itself, and a call that reached the router and was abandoned by the
 * caller still leaves a record. A row is therefore *observed*, never reported:
 * an agent that dies mid-interview does not take its call's history with it.
 *
 * ## The two rules that keep the record honest
 *
 *   1. **A blank never overwrites a fact.** `recordEnvelope` fills only what is
 *      unknown, because the same call arrives several times (one `VarSet` per
 *      variable, in whatever order the dialplan sets them) and the last write
 *      must not erase an account id that an earlier one established.
 *   2. **The disposition is the path, not the outcome.** A call handed to
 *      Capstone and then ended is `handed_off` with an `ended_at`: which agent
 *      the caller reached is the fact worth keeping, and the end time is a
 *      separate column.
 */
import db from "./db";

/** The path a call took. `concluded` is "ended with no hand-off". */
export type Disposition = "in_progress" | "handed_off" | "returned" | "concluded";

/** Who a call moved to. `ava` is the hand-back. */
export type HandoffTarget = "capstone" | "operator" | "ava" | "voicemail";

export interface HandoffEvent {
  to: HandoffTarget;
  at: string;
}

export interface VoiceCall {
  call_id: string;
  account_id: string | null;
  did: string | null;
  agent_slug: string | null;
  capstone_binding: string | null;
  started_at: string;
  ended_at: string | null;
  disposition: Disposition;
  handoffs: HandoffEvent[];
  updated_at: string;
}

interface VoiceCallRow extends Omit<VoiceCall, "handoffs"> {
  handoffs: string;
}

function hydrate(row: VoiceCallRow): VoiceCall {
  let handoffs: HandoffEvent[] = [];
  try {
    const parsed = JSON.parse(row.handoffs || "[]");
    if (Array.isArray(parsed)) handoffs = parsed as HandoffEvent[];
  } catch {
    // A hand-written or truncated value must not make the row unreadable: the
    // call record is still the call record without its path.
    handoffs = [];
  }
  return { ...row, handoffs };
}

/** A fact about a call, as the channel reported it. Every field but the id is optional. */
export interface EnvelopeFacts {
  call_id: string;
  account_id?: string | null;
  did?: string | null;
  agent_slug?: string | null;
  capstone_binding?: string | null;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed || trimmed === "(null)" || trimmed === "unset") return null;
  return trimmed;
}

/**
 * Record what the channel's envelope said, without clobbering a known fact with
 * a blank one.
 *
 * `COALESCE(voice_calls.x, excluded.x)` is the whole rule: the incoming value is
 * used only where the row has nothing yet. A DID still wins over a `FROM_DID`
 * that arrives empty on a later event, and an account id established at ingress
 * is not lost when the hand-off re-stamps the same variables.
 */
export function recordEnvelope(facts: EnvelopeFacts): void {
  const callId = clean(facts.call_id);
  if (!callId) return;

  db.prepare(
    `INSERT INTO voice_calls (call_id, account_id, did, agent_slug, capstone_binding, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(call_id)
       DO UPDATE SET account_id       = COALESCE(voice_calls.account_id, excluded.account_id),
                     did              = COALESCE(voice_calls.did, excluded.did),
                     agent_slug       = COALESCE(voice_calls.agent_slug, excluded.agent_slug),
                     capstone_binding = COALESCE(voice_calls.capstone_binding, excluded.capstone_binding),
                     updated_at       = datetime('now')`,
  ).run(
    callId,
    clean(facts.account_id),
    clean(facts.did),
    clean(facts.agent_slug),
    clean(facts.capstone_binding),
  );
}

/**
 * Append one hand-off and set the disposition that names it.
 *
 * `returned` is the hand-back, and it is deliberately not `in_progress`: the
 * screen has to be able to say the call moved twice, which is the whole point of
 * D3's `[zeus-ai-return]`. The hand-offs array keeps every hop, in order, so a
 * conclusion reached from it can name the path rather than a count.
 */
export function noteHandoff(callId: string, to: HandoffTarget): void {
  const id = clean(callId);
  if (!id) return;

  const disposition: Disposition = to === "capstone" ? "handed_off" : "returned";
  // `$[#]` is "one past the last element", so every hop is appended in order and
  // none is replaced. The column's `'[]'` default is load-bearing: appending to
  // NULL would drop the event rather than fail.
  //
  // Two spellings of one hop, on purpose: the insert needs the array the column
  // starts with, while `json_insert(…, '$[#]', json(?))` appends the *element* —
  // handing it the array would nest it, and the reader would then see a hop with
  // no `to` rather than an error.
  const hop = { to, at: new Date().toISOString() };
  const event = JSON.stringify(hop);
  const initial = JSON.stringify([hop]);
  db.prepare(
    `INSERT INTO voice_calls (call_id, disposition, handoffs, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(call_id)
       DO UPDATE SET handoffs    = json_insert(voice_calls.handoffs, '$[#]', json(?)),
                     disposition = ?,
                     updated_at  = datetime('now')`,
  ).run(id, disposition, initial, event, disposition);
}

/**
 * Mark the call ended.
 *
 * The disposition is only *completed* to `concluded` when nothing moved it: a
 * call that reached Capstone stays `handed_off`, because the end time is already
 * a separate column and overwriting the path with "it ended" throws away the
 * answer the operator asked for.
 */
export function concludeCall(callId: string): void {
  const id = clean(callId);
  if (!id) return;
  db.prepare(
    `UPDATE voice_calls
        SET ended_at    = COALESCE(ended_at, datetime('now')),
            disposition = CASE WHEN disposition = 'in_progress' THEN 'concluded' ELSE disposition END,
            updated_at  = datetime('now')
      WHERE call_id = ?`,
  ).run(id);
}

/** One call's full record, or null. */
export function getVoiceCall(callId: string): VoiceCall | null {
  const row = db
    .prepare("SELECT * FROM voice_calls WHERE call_id = ?")
    .get(callId) as VoiceCallRow | undefined;
  return row ? hydrate(row) : null;
}

/** The most recent calls, newest first. `accountId` narrows to one account. */
export function listVoiceCalls(limit = 50, accountId?: string): VoiceCall[] {
  const rows = (
    accountId
      ? db
          .prepare(
            `SELECT * FROM voice_calls WHERE account_id = ?
              ORDER BY started_at DESC, call_id DESC LIMIT ?`,
          )
          .all(accountId, limit)
      : db
          .prepare(
            "SELECT * FROM voice_calls ORDER BY started_at DESC, call_id DESC LIMIT ?",
          )
          .all(limit)
  ) as VoiceCallRow[];
  return rows.map(hydrate);
}

/**
 * Calls with no end time, newest first — the live view's own half.
 *
 * A call whose Hangup never arrived (an AMI reconnect is the usual reason) stays
 * here, which is why the view shows `started_at` beside it: a "live" call from
 * two hours ago is a fact about the AMI connection, and hiding it would make the
 * screen lie about now.
 */
export function activeVoiceCalls(): VoiceCall[] {
  const rows = db
    .prepare(
      "SELECT * FROM voice_calls WHERE ended_at IS NULL ORDER BY started_at DESC, call_id DESC LIMIT 100",
    )
    .all() as VoiceCallRow[];
  return rows.map(hydrate);
}

/**
 * Which hand-off, if any, an Asterisk context names.
 *
 * Derived from the contexts the dialplan actually loads, so this reads the
 * dialplan's own vocabulary rather than keeping a second copy of it:
 *
 *   * `dograh-inbound` — Capstone's context. D3 makes the dialplan name the
 *     *context and extension* and never `Stasis(dograh_<suffix>)`, precisely so
 *     that a caller can say "entered Capstone" without knowing Capstone's
 *     runtime-generated app name. This is that caller.
 *   * `zeus-ai-return` — the way back (D3), which fires exactly once, on the
 *     return leg.
 *
 * The **operator leg is deliberately absent.** A refused hand-off reuses
 * `[zeus-ai-handoff]`'s own `refused` extension (P2's implementation detail), so
 * the context a refusal lands in is indistinguishable from a transfer that
 * succeeded — naming that hop needs the refusal destination settled (§11.1).
 * `"operator"` stays in the vocabulary because the record should be able to
 * hold what the system cannot yet observe, rather than growing a migration the
 * day it can.
 */
export function handoffFromContext(context: string): HandoffTarget | null {
  const name = (context ?? "").trim().toLowerCase();
  if (!name) return null;
  if (name === "dograh-inbound" || name.startsWith("dograh")) return "capstone";
  if (name === "zeus-ai-return") return "ava";
  return null;
}

/** The same rows keyed by id, for joining onto another product's list. */
export function voiceCallsByCallId(callIds: string[]): Map<string, VoiceCall> {
  const wanted = callIds.map(clean).filter((id): id is string => Boolean(id));
  if (wanted.length === 0) return new Map();

  const placeholders = wanted.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM voice_calls WHERE call_id IN (${placeholders})`)
    .all(...wanted) as VoiceCallRow[];

  return new Map(rows.map((row) => [row.call_id, hydrate(row)]));
}

/**
 * Prior calls to the same number, answered from the switch's own store.
 *
 * The context read (`src/lib/voice-context.ts`) used to count these out of a
 * voice engine's record list. With one engine, the portal does not need one to
 * ask: `voice_calls` is filled by `ami-handler.ts` from the channel's own AMI
 * events, so it holds every call the switch saw whether or not an agent ever
 * picked it up — a more complete record than either engine's.
 *
 * Matched on the dialled number, the only column here that describes the
 * caller's side. The table deliberately carries no caller-identifying field
 * (the switch records what this platform owns, not who rang), so a number the
 * portal does not know returns zero rather than a guess at a match.
 */
export function priorCallsForDid(
  did: string,
  excludeCallId: string,
  limit = 200,
): { count: number; last_at: string | null; last_call_id: string | null } {
  const rows = db
    .prepare(
      `SELECT call_id, started_at FROM voice_calls
        WHERE did = ? AND call_id != ?
        ORDER BY started_at DESC
        LIMIT ?`,
    )
    .all(did, excludeCallId, limit) as { call_id: string; started_at: string | null }[];

  const latest = rows[0];
  return {
    count: rows.length,
    last_at: latest?.started_at ?? null,
    last_call_id: latest?.call_id ?? null,
  };
}
