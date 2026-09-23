/**
 * The two values the portal hands to the dialplan, and the rule for each.
 *
 * Both are mirrored from the renderer that actually writes them,
 * `pbx/ava_routing.py`, and they are here in one importless module for two
 * reasons: one rule has one reader on each side, and a module with no imports
 * can be checked against its authority's regex directly (see the parity probe
 * in this repo's history: the same candidates, run through both), instead of
 * being trusted because the two string literals looked alike.
 *
 * Neither value is a *security* boundary — the renderer validates both and
 * aborts the whole plan on a bad one, which leaves the PBX on its last good
 * fragment. Enforcing them on the way in is what stops a bad value reaching the
 * database at all, so the failure is a refused request rather than a PBX that
 * stops converging.
 */

/**
 * The national form of a dialled number, mirroring `normalize_did` in
 * pbx/ava_routing.py: FreePBX routes and `[zeus-ai-accounts]` keys match the
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
 * What a Capstone interview target may be, mirroring `SAFE_TOKEN_RE` in
 * pbx/ava_routing.py — verbatim, on purpose.
 *
 * The value lands inside `DIALPLAN_EXISTS(dograh-inbound,${ZEUS_CAPSTONE_TARGET},1)`,
 * so a target containing `)` or `}` could close that call and inject the rest
 * of the expression. The charset is the same one the provider and
 * audio-profile overrides are held to, for the same reason.
 *
 * This is about syntax, not existence: whether Capstone carries a workflow at
 * that extension is Capstone's own `[dograh-inbound]` context, and the dialplan
 * resolves it — refusing to the operator rather than reaching a default agent.
 */
export const CAPSTONE_TARGET_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export function isSafeCapstoneTarget(value: string): boolean {
  return CAPSTONE_TARGET_RE.test(value);
}
