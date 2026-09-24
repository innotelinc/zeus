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

function normalizeUsNumber(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || !/^[+\d().\s-]+$/.test(trimmed)) return null;

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return null;
}
