/**
 * What a create is doing while the operator waits.
 *
 * Creating an extension used to be a single FreePBX write that returned in well
 * under a second, so the panel could say "Provisioning..." and be honest. It is
 * not that any more: `POST /api/phone/extensions` now queues FreePBX's Apply
 * Config between writing the rows and reading back the credential the softphone
 * has to register with, because until a reload runs there is no `[<ext>]` and no
 * `[<ext>-auth]` to read (src/lib/freepbx-apply.ts). A reload on `.30` measures
 * 11-30s, so the button sat on one word for half a minute with nothing to say
 * whether the request was working or the tab had died.
 *
 * The fix is a sentence that changes with the clock, which means the copy is a
 * function of elapsed time rather than of anything the server sends back — the
 * server cannot say "the reload is running" until the reload is done, and the
 * whole point is to say something *before* that. So it lives here, pure and
 * testable, instead of inline in the component where it could only be asserted
 * by reading JSX.
 *
 * The thresholds are the measured ones. Under `APPLY_STARTS_MS` the request is
 * still FreePBX's own write, which is fast; from there it is the reload, whose
 * honest range is 11-30s; past `APPLY_TYPICAL_MAX_MS` it is slow but still
 * inside the server's 45s budget, and saying so is the difference between "this
 * is slow" and "this is broken".
 */

/** Before this, the request is FreePBX's write and the reload has not started. */
export const APPLY_STARTS_MS = 3_000;
/** The top of the measured range for a reload: 11-30s. */
export const APPLY_TYPICAL_MAX_MS = 30_000;
/** The server stops waiting here (APPLY_TIMEOUT_MS), so the panel can too. */
export const APPLY_TIMEOUT_MS = 45_000;

export type ProvisionStage = "writing" | "applying" | "slow";

export interface ProvisionProgress {
  stage: ProvisionStage;
  /** The headline, in the panel. */
  title: string;
  /** What is happening and what the operator should do about it. */
  detail: string;
  /** Whole seconds since the request was sent, for a waiting operator to read. */
  seconds: number;
  /** Whether the wait is longer than the measured range, not longer than the budget. */
  slow: boolean;
}

/**
 * The message for a create that has been in flight for `elapsedMs`.
 *
 * Never returns a message about failure: past the server's budget the request is
 * about to fail on its own and the catch block will say so with the server's own
 * words, which are better than anything derivable from a stopwatch.
 */
export function provisionProgress(elapsedMs: number): ProvisionProgress {
  const ms = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  const seconds = Math.floor(ms / 1_000);

  if (ms < APPLY_STARTS_MS) {
    return {
      stage: "writing",
      title: "Creating the extension…",
      detail:
        "Writing the extension's user, device and mailbox in FreePBX.",
      seconds,
      slow: false,
    };
  }

  if (ms < APPLY_TYPICAL_MAX_MS) {
    return {
      stage: "applying",
      // Named, not "please wait": the wait is FreePBX regenerating the config the
      // softphone's credential comes out of, and that is why it cannot be skipped.
      title: "Applying PBX config…",
      detail:
        "FreePBX regenerates its PJSIP config here, which is where the " +
        "softphone's secret comes from. Measured at 11–30 seconds — leave this open.",
      seconds,
      slow: false,
    };
  }

  if (ms < APPLY_TIMEOUT_MS) {
    return {
      stage: "slow",
      title: "Applying PBX config — slower than usual…",
      detail:
        "The reload is taking longer than the 11–30 seconds it measures. " +
        "The portal waits up to 45 seconds; the extension is created either way.",
      seconds,
      slow: true,
    };
  }

  return {
    stage: "slow",
    title: "Applying PBX config — past the portal's budget…",
    detail:
      "The PBX has not reported the reload finished. The extension exists; " +
      "the request is about to answer with what the PBX last said.",
    seconds,
    slow: true,
  };
}

/** The `apply_config` half of the create's answer, as far as this module needs it. */
export interface ApplyConfigAnswer {
  applied?: boolean;
  state?: string;
  detail?: string;
}

/**
 * What to tell the operator about the reload, after the create has answered.
 *
 * `applied` is the only state that means the extension can register now. The
 * others are not create failures — the rows exist and a hardware phone can use
 * them — but the credential the softphone needs was never rendered, which is the
 * state `Repair` exists to adopt. Saying that here is what stops the next
 * question being "why is it Offline?".
 *
 * Returns `""` when there is nothing worth saying, so the caller can use a falsy
 * check rather than branching on the state itself.
 */
export function describeApplyConfig(apply: ApplyConfigAnswer | null | undefined): string {
  if (!apply) return "";
  if (apply.applied) return "";

  const why =
    apply.state === "timeout"
      ? "It did not finish inside the portal's 45-second budget"
      : apply.state === "unreachable"
        ? "The PBX's API could not be reached to queue a reload"
        : apply.state === "refused"
          ? "The PBX answered but would not queue a reload"
          : apply.state === "failed"
            ? "The PBX ran the reload and it failed"
            : "The PBX did not confirm the reload";

  const detail = apply.detail ? ` (${apply.detail})` : "";
  return (
    `${why}${detail}. The extension was created and its rows are live, but FreePBX ` +
    `has not rendered its SIP secret, so a softphone cannot register yet. ` +
    `Run Repair on the row once the PBX is reachable.`
  );
}
