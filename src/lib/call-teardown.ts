/**
 * Ending a call: who gets asked first, and what happens when the answer is no.
 *
 * Hang-up used to send this leg's SIP BYE first and then fire the AMI cleanup at
 * the PBX without waiting or reading its answer. Both halves are wrong.
 *
 * The BYE is what removes the channel the cleanup needs: the extension's own leg
 * is the only handle on the far end — `src/lib/ami-channels.ts` joins the peer by
 * the bridge *that leg* is in — so clearing it first is how the party the caller
 * was actually talking to stays connected. And a fire-and-forget request with its
 * failure swallowed cannot tell an unreachable PBX (a 401, a restart, a timeout)
 * from a hang-up that worked: the panel went idle either way.
 *
 * So the PBX is asked first and its answer is read. If it cleared this leg too,
 * Asterisk sends the BYE and nothing more is needed. Otherwise — it answered and
 * found nothing, or it could not be reached — this leg's BYE goes out, because a
 * call left up is worse than a redundant BYE. A slow PBX gets `timeoutMs` and
 * then the BYE is sent anyway.
 *
 * Pure, so the order is pinned against fakes rather than against a live PBX.
 */

/** The fields of `POST /api/ami/hangup`'s answer this decision reads. */
export interface TeardownAnswer {
  success?: boolean;
  /** Channels cleared that belong to the extension itself. */
  hung_up_local?: number;
}

export interface TeardownPlan {
  /** Ask the PBX to clear the call, far end first. Rejects when it cannot be asked. */
  requestPbxTeardown: () => Promise<TeardownAnswer | null>;
  /** Clear this leg over SIP. Only ever called when the PBX did not. */
  sendBye: () => void;
  timeoutMs?: number;
  /** Where a swallowed failure goes now: it is logged, not discarded. */
  onError?: (error: unknown) => void;
}

/** Who ended the call: the PBX (`"pbx"`) or this leg's own BYE (`"bye"`). */
export type TeardownOutcome = "pbx" | "bye";

/** How long the PBX has to answer before the BYE goes anyway. */
export const TEARDOWN_TIMEOUT_MS = 1500;

function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function teardownCall(plan: TeardownPlan): Promise<TeardownOutcome> {
  const { requestPbxTeardown, sendBye, timeoutMs = TEARDOWN_TIMEOUT_MS, onError } = plan;

  let answer: TeardownAnswer | null = null;
  try {
    answer = await within(requestPbxTeardown(), timeoutMs);
  } catch (error) {
    onError?.(error);
    answer = null;
  }

  // Only the local leg's own hang-up means Asterisk will send the BYE. A PBX that
  // cleared the far end but left this leg standing still needs the BYE.
  if (answer?.success === true && (answer.hung_up_local ?? 0) > 0) return "pbx";

  sendBye();
  return "bye";
}
