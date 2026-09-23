/**
 * Per-DID Capstone bindings — which interview workflow an account's line
 * reaches.
 *
 * `voice_bindings(user_id, did, capstone_binding)` is keyed per **(account,
 * number)**, not per account: one account can hold a support line and an
 * interview line, and *which interview* is a property of the number. It is also
 * deliberately not a column on `account_addons` — that table records a Magnate
 * decision (may this account reach Capstone at all), this one records the
 * customer's own choice (which workflow answers it).
 *
 * The two are enforced in that order at render time: `pbx/ava_routing.py` (and
 * `/api/admin/voice-routing`) publish a binding **only beside a true
 * entitlement**, so a row left behind by a cancelled subscription is inert
 * rather than a way back in. That also means this module does not have to be
 * the gate — but it still checks the add-on, because accepting a choice the
 * routing will silently discard is how an operator comes to believe they
 * configured something.
 *
 * ## The target's rule is the renderer's rule
 *
 * The stored value is interpolated into the dialplan as
 * `DIALPLAN_EXISTS(dograh-inbound,${ZEUS_CAPSTONE_TARGET},1)`, so a value
 * containing `)` or `}` can close that call and inject the rest. The same
 * charset the renderer enforces on the way *out*
 * (`pbx/ava_routing.py`'s `SAFE_TOKEN_RE`, mirrored in `./dialplan-values`) is
 * therefore enforced on the way *in*, so a bad target cannot be stored by the
 * API and discovered by the renderer. One rule, one place, two readers.
 *
 * The rule is about *syntax*, not existence: whether Capstone actually carries
 * a workflow with that extension is Capstone's own context
 * (`[dograh-inbound]`) and is resolved by the dialplan, which refuses to the
 * operator rather than guessing.
 */
import db from "./db";
import { normalizeDid } from "./dialplan-values";

/** One of the account's numbers and the workflow it reaches, if any. */
export interface InterviewLine {
  did: string;
  capstone_binding: string | null;
}

/**
 * The account's active numbers with their bindings.
 *
 * The join is on the DID as stored (`phone_numbers.did`), which is also what
 * `pbx/ava_routing.py` keys its bindings by — normalizing one side here would
 * only add a way for the two to disagree.
 */
export function accountLines(userId: string): InterviewLine[] {
  return db
    .prepare(
      `SELECT pn.did              AS did,
              vb.capstone_binding AS capstone_binding
         FROM phone_numbers pn
         LEFT JOIN voice_bindings vb
                ON vb.user_id = pn.user_id AND vb.did = pn.did
        WHERE pn.user_id = ? AND pn.status = 'active'
        ORDER BY pn.did`,
    )
    .all(userId) as InterviewLine[];
}

/**
 * The stored form of one of the account's own active numbers, or null.
 *
 * A caller may pass the number with punctuation or a country code; what gets
 * stored is the row's own string, because that is what the renderer joins on.
 * Accepting the input verbatim would store a binding that no plan lookup ever
 * matches, and the operator would see the UI accept a value the PBX ignores.
 */
export function resolveOwnedDid(userId: string, did: string): string | null {
  const wanted = normalizeDid(did);
  if (!wanted) return null;

  const rows = db
    .prepare("SELECT did FROM phone_numbers WHERE user_id = ? AND status = 'active'")
    .all(userId) as Array<{ did: string }>;

  const exact = rows.find((row) => row.did === did);
  if (exact) return exact.did;
  return rows.find((row) => normalizeDid(row.did) === wanted)?.did ?? null;
}

/**
 * Set or clear one line's binding.
 *
 * Clearing deletes the row rather than storing an empty string: "no row" and
 * "row with no target" mean the same thing to both readers, and one of them is
 * absent from the table rather than present in two spellings.
 */
export function setBinding(userId: string, did: string, target: string | null): void {
  if (!target) {
    db.prepare("DELETE FROM voice_bindings WHERE user_id = ? AND did = ?").run(userId, did);
    return;
  }
  db.prepare(
    `INSERT INTO voice_bindings (user_id, did, capstone_binding, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, did)
       DO UPDATE SET capstone_binding = excluded.capstone_binding,
                     updated_at = excluded.updated_at`,
  ).run(userId, did, target);
}
