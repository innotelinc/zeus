/**
 * The `account_addons` audit trail — the last entitlement answer recorded per
 * (account, SKU).
 *
 * The plan the PBX renders is the routing authority; this table is the record
 * of *why* it says what it says, and the only place a later reader sees a
 * Magnate decision without another round trip (`src/lib/voice-context.ts`, on
 * the call path, and an operator in the admin console).
 *
 * ## Why this is a module and not three inline statements
 *
 * D5 says add-on enablement is **one transaction**: entitlement → the recorded
 * decision → rendered routing → portal UI. The defect that sentence names is not
 * that a cache exists — the design keeps it deliberately, as an audit trail — it
 * is that the cache used to be filled in by whoever happened to pass by:
 * `/api/admin/voice-routing` upserted a row *inside* its per-account loop, so a
 * request that stopped partway left a record that disagreed with the plan it
 * published; and a write path that had just acted on a gate answer (the voice
 * mapping) recorded nothing at all, leaving the row for a different route to
 * fill in later from a different answer.
 *
 * So every writer goes through here, and every writer records **the answer it
 * acted on, in the same commit as the write it authorised**:
 *
 *   * `/api/admin/voice-routing` — every account, one commit, once the whole
 *     plan is known. A partial cache under a published plan is exactly the
 *     drift, so the batch is all-or-nothing.
 *   * `/api/voice/agent-mapping` — the account's own row, inside the existing
 *     mapping transaction, from the gate answers that authorised that write.
 *
 * ## A false answer is never written speculatively
 *
 * Only the two authoritative states reach this module. An *indecisive* gate (a
 * rejected Magnate token, a billing outage) must leave the last good answer in
 * place: a `0` written from "could not tell" is indistinguishable from a lapsed
 * subscription to every reader, and the whole point of the fail-open policy in
 * `./addons` is that a config error must not un-wire a paying customer's lines.
 */
import db from "./db";
import type { AddonSku } from "./addons";

/** One decision to record: this account, this SKU, this answer. */
export interface AddonDecisionRecord {
  userId: string;
  sku: AddonSku;
  entitled: boolean;
}

const UPSERT = `INSERT INTO account_addons (user_id, addon, entitled, checked_at)
                VALUES (?, ?, ?, datetime('now'))
                ON CONFLICT(user_id, addon)
                  DO UPDATE SET entitled = excluded.entitled,
                                checked_at = excluded.checked_at`;

/**
 * Record one answer.
 *
 * Safe to nest inside a caller's own `db.transaction` — better-sqlite3 runs the
 * inner one as a savepoint — which is how the voice-mapping write keeps its
 * mapping and its entitlement record in one commit.
 */
export function recordAddonDecision(
  userId: string,
  sku: AddonSku,
  entitled: boolean,
): void {
  db.prepare(UPSERT).run(userId, sku, entitled ? 1 : 0);
}

/**
 * Record many answers in **one** transaction, or record none of them.
 *
 * A batch is what the routing plan produces (one account per DID, each with its
 * own gate answer), and the guarantee is the point: a plan is published whole,
 * so the trail behind it is written whole. An emptied list is a no-op, not an
 * empty transaction, so a PBX with no active DIDs costs nothing.
 */
export function recordAddonDecisions(records: readonly AddonDecisionRecord[]): void {
  if (records.length === 0) return;
  const write = db.transaction((rows: readonly AddonDecisionRecord[]) => {
    for (const row of rows) recordAddonDecision(row.userId, row.sku, row.entitled);
  });
  write(records);
}

/**
 * The last recorded answer for an account and SKU.
 *
 * `null` means **nothing has ever been recorded** — which is not `false`. The
 * dialplan renderer treats a missing row as not-entitled (fail closed), so a
 * reader that has to choose must make the same choice, but the two remain
 * distinguishable here so an operator can tell "billing said no" from "nobody
 * has ever asked".
 */
export function cachedAddonDecision(userId: string, sku: AddonSku): boolean | null {
  const row = db
    .prepare("SELECT entitled FROM account_addons WHERE user_id = ? AND addon = ?")
    .get(userId, sku) as { entitled: number } | undefined;
  return row ? row.entitled === 1 : null;
}
