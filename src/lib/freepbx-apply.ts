/**
 * Run FreePBX's Apply Config and wait for it, because the credential only
 * exists once it has finished.
 *
 * `addExtension` and `deleteExtension` write rows; the config everything reads
 * back (`pjsip.endpoint.conf`, `pjsip.auth.conf`) is regenerated only by an
 * apply. So a create that does not apply produces an extension that routes,
 * holds a mailbox and cannot be registered against — the portal's stored secret
 * is a portal-issued one that authenticates nothing, because FreePBX never
 * rendered its own. The GUI hides the gap behind its Apply Config button; where
 * the portal is the one creating the extension, the portal is the one that has
 * to press it.
 *
 * `doreload` queues `fwconsole api doreload <txnId>` in the background and
 * returns the transaction id, so the shape of this module is: queue, then poll
 * `fetchApiStatus` until the transaction leaves "Processing". Measured on `.30`
 * a reload is 11-30s, which is the honest cost of Apply Config and the reason
 * the budget below is generous.
 *
 * **Applies are serialised, not coalesced.** Reusing an in-flight apply would
 * be wrong for a caller whose rows were written after that apply began reading
 * — it would be told "applied" for config that does not contain its extension.
 * Chaining instead means every caller gets a regeneration that started after
 * its own writes, and two operators creating at the same moment cannot put two
 * `fwconsole reload`s on the box at once.
 */
import { applyConfiguration, fetchApiStatus } from "./freepbx";

/** How long to wait for a queued reload before giving up on it. */
export const APPLY_TIMEOUT_MS = 45_000;
/** How often to ask the PBX whether the transaction has finished. */
export const APPLY_POLL_MS = 1_000;

export interface ApplyOutcome {
  /** The config was regenerated — so whatever FreePBX renders now exists. */
  applied: boolean;
  /**
   * Why, in one word the caller can branch on:
   *   applied    — the reload ran
   *   failed     — FreePBX ran it and reported a failure
   *   timeout    — still Processing when the budget ran out
   *   unreachable— the API could not be asked (queued, or polled)
   *   refused    — the API answered but would not queue a reload
   */
  state: "applied" | "failed" | "timeout" | "unreachable" | "refused";
  /** What the PBX said, for the operator. Empty when there is nothing to say. */
  detail: string;
  transactionId: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function reason(e: unknown): string {
  return e instanceof Error ? e.message : "the request failed without a message";
}

/** The tail of the apply chain — see the note about serialising above. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Queue an Apply Config and resolve once it has finished.
 *
 * Never throws: every outcome is a value, because the caller's extension exists
 * either way and the only question is whether its credential does. A caller
 * that cannot apply must report that, not fail the create.
 */
export function applyConfigAndWait(
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<ApplyOutcome> {
  const timeoutMs = opts.timeoutMs ?? APPLY_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? APPLY_POLL_MS;
  const next = queue.then(
    () => runApply(timeoutMs, pollMs),
    () => runApply(timeoutMs, pollMs),
  );
  // The chain must not carry a rejection forward, and callers must not inherit
  // one from a previous run.
  queue = next.catch(() => undefined);
  return next;
}

async function runApply(timeoutMs: number, pollMs: number): Promise<ApplyOutcome> {
  let queued;
  try {
    queued = await applyConfiguration();
  } catch (e) {
    return { applied: false, state: "unreachable", detail: reason(e), transactionId: "" };
  }

  const transactionId = String(queued?.transaction_id ?? "").trim();
  if (!queued?.status || !transactionId) {
    return {
      applied: false,
      state: "refused",
      detail: queued?.message ?? "the PBX did not queue a reload",
      transactionId,
    };
  }

  const deadline = Date.now() + timeoutMs;
  let lastState = "Processing";
  let lastError = "";

  while (Date.now() < deadline) {
    await sleep(pollMs);
    let status;
    try {
      status = await fetchApiStatus(transactionId);
    } catch (e) {
      // A poll that failed is not a reload that failed. Keep asking until the
      // budget runs out, and carry the last error in case it never recovers.
      lastError = reason(e);
      continue;
    }
    lastState = String(status?.message ?? "").trim() || lastState;

    if (lastState === "Executed") {
      return { applied: true, state: "applied", detail: "", transactionId };
    }
    if (lastState === "Failed" || status?.status === false) {
      return {
        applied: false,
        state: "failed",
        detail: String(status?.details ?? "").trim() || lastState,
        transactionId,
      };
    }
  }

  return {
    applied: false,
    state: "timeout",
    detail: lastError
      ? `${lastState} — the last poll failed: ${lastError}`
      : lastState,
    transactionId,
  };
}
