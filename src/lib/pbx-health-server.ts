/**
 * Ask the PBX which outbound trunks are registered — the one fact the portal's
 * cache cannot hold, shared by every surface that needs to raise it.
 *
 * Split from `pbx-health.ts` for the reason `extension-readiness-server.ts` is
 * split from `extension-readiness.ts`: the pure module is imported by client
 * components (`PbxHealthPanel`), so it must stay free of the AMI client and its
 * `node:net`. This half touches the PBX and is server-only.
 *
 * The shape keeps "no trunks" and "could not ask" apart, because they look
 * identical downstream and mean opposite things: `trunks: null` with an `error`
 * is a portal that cannot see the PBX (report it as unverifyable — never as
 * healthy), while `trunks: []` is a box with no outbound registrations at all.
 */
import { getAmiClient } from "./ami";
import { failingTrunks, summarizeTrunks, type TrunkRegistration } from "./pbx-health";

export interface TrunkHealth {
  /** The registrations, or null when the PBX could not be asked. */
  trunks: TrunkRegistration[] | null;
  /** The registrations the PBX did not accept; empty when unreadable. */
  failing: TrunkRegistration[];
  /** Why the read failed, when it did. */
  error?: string;
}

export async function readTrunkHealth(): Promise<TrunkHealth> {
  const ami = getAmiClient();
  if (!ami.isConnected) {
    return { trunks: null, failing: [], error: "AMI not connected" };
  }
  try {
    // `summarizeTrunks` drops the `AuthDetail` events this action interleaves,
    // so the trunk's clear-text password cannot reach a response body.
    const trunks = summarizeTrunks(await ami.listOutboundRegistrations());
    return { trunks, failing: failingTrunks(trunks) };
  } catch (e) {
    return {
      trunks: null,
      failing: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * One line naming what is wrong, for a surface with room for a sentence rather
 * than a list of trunk names.
 */
export function trunkHealthError(health: TrunkHealth): string {
  if (health.trunks === null) {
    return `${health.error ?? "the PBX could not be read"} — cannot tell whether outbound trunks are registered`;
  }
  const names = health.failing.map((trunk) => `${trunk.name} (${trunk.status})`);
  return `${names.join(", ")} not registered — outbound calls through ${
    names.length === 1 ? "it" : "them"
  } will fail`;
}
