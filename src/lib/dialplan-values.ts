/**
 * The two values the portal reads off a number, and the rule for each.
 *
 * They are here in one importless module for two reasons: one rule has one
 * reader, and a module with no imports can be exercised without a database or
 * an AMI connection. Both rules are enforced on the way *in* (the API refuses a
 * value it cannot store safely), rather than being discovered later by whatever
 * interpolates them.
 *
 * Neither value is a *security* boundary — the caller still owns what it does
 * with an accepted value — but a refused request is a better failure than a
 * dialplan expression that stops converging.
 */

/**
 * The national form of a dialled number: FreePBX routes and account keys match
 * the
 * 10-digit national form, so `+1 (774) 505-7135` and `17745057135` have to
 * resolve to the account stored as `7745057135` — otherwise the context read
 * reports no account for a call the router itself routed by account.
 */
export function normalizeDid(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

/**
 * What a Capstone interview target may be — the charset every workflow key is
 * held to, verbatim, on purpose.
 *
 * The value lands inside `DIALPLAN_EXISTS(dograh-inbound,${ZEUS_CAPSTONE_TARGET},1)`,
 * so a target containing `)` or `}` could close that call and inject the rest
 * of the expression. The charset is the same one the provider and
 * audio-profile overrides are held to, for the same reason.
 *
 * This is about syntax, not existence: whether the engine carries a workflow at
 * that extension is the engine's own answer, and a refusal here is to the
 * operator rather than a fallback to a default agent.
 */
export const CAPSTONE_TARGET_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export function isSafeCapstoneTarget(value: string): boolean {
  return CAPSTONE_TARGET_RE.test(value);
}
