import db from "./db";

/**
 * Resolve an optional outbound caller ID against the account's active DIDs.
 *
 * `undefined` means use FreePBX's configured outbound-route policy; `null`
 * means the supplied value is invalid or is not an active DID owned by the
 * account. Returned values are canonical 10-digit US numbers.
 */
export function resolveOwnedCallerId(
  requested: string | undefined,
  activeDids: readonly string[],
): string | undefined | null {
  if (requested === undefined) return undefined;

  const normalized = normalizeUsNumber(requested);
  if (!normalized) return null;

  return activeDids.some((did) => normalizeUsNumber(did) === normalized)
    ? normalized
    : null;
}

/**
 * The account's own active DIDs, read from the table the originate route gates
 * on. Kept next to the resolver so the query and the comparison cannot drift:
 * the ownership check is `user_id = ?`, and a caller can never present a number
 * that belongs to another account because the row is never selected here.
 */
export function activeDidsForUser(userId: string): string[] {
  return (
    db
      .prepare("SELECT did FROM phone_numbers WHERE user_id = ? AND status = 'active'")
      .all(userId) as Array<{ did: string }>
  ).map((row) => row.did);
}

/** The resolver the originate route calls: ownership and syntax in one step. */
export function resolveCallerIdForUser(
  userId: string,
  requested: string | undefined,
): string | undefined | null {
  return resolveOwnedCallerId(requested, activeDidsForUser(userId));
}

function normalizeUsNumber(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || !/^[+\d().\s-]+$/.test(trimmed)) return null;

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return null;
}
