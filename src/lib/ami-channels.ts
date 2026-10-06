/**
 * Which channels one extension's live call is made of.
 *
 * A softphone's own leg is the only channel the portal can name, and it is not
 * the one the other party stays connected to: the far end is a *bridged peer* —
 * the trunk channel, or the engine's own channel. Acting on the extension's leg
 * alone is why "hang up" left the caller up and why a hold had nothing to put on
 * music.
 *
 * The join between the two is the bridge id the PBX reports on a
 * `CoreShowChannel` event (`BridgeId`). The AMI `Status` event is not a
 * substitute: it spells the field `BridgeID` and carries it only for a channel
 * that is actually in a bridge, which is why code that looked for
 * `BridgedChannel`/`BridgePeer`/`BridgeId` on a `Status` row found nothing on
 * every live call.
 *
 * Pure, so the join is pinned against the shapes AMI really emits.
 */

/** One `CoreShowChannel` event, as the raw key/value block AMI sends. */
export type AmiChannelRow = Record<string, string>;

export interface CallLegs {
  /** The extension's own channels (`PJSIP/<ext>-…`). */
  local: string[];
  /** Every channel bridged to one of them — the far end(s). */
  remote: string[];
}

/** The channel-name prefix the PBX gives one extension's endpoint. */
export function extensionPrefix(extension: string): string {
  return `PJSIP/${extension}-`;
}

/**
 * Split a CoreShowChannels listing into the extension's own legs and the peers
 * they are bridged to.
 *
 * A channel with an empty `BridgeId` is not in a bridge and cannot contribute a
 * peer; a channel with a bare `BridgeId` that no local leg names is somebody
 * else's call and is left alone. Both matter: acting on a stranger's channel is
 * how one account's hang-up disconnects another's call.
 */
export function callLegs(rows: AmiChannelRow[], extension: string): CallLegs {
  const prefix = extensionPrefix(extension);
  const own = rows.filter((row) => (row.Channel ?? "").startsWith(prefix));
  const local = own.map((row) => row.Channel ?? "").filter(Boolean);

  const bridges = new Set(own.map((row) => row.BridgeId ?? "").filter(Boolean));
  const remote = rows
    .filter(
      (row) =>
        Boolean(row.Channel) &&
        !(row.Channel ?? "").startsWith(prefix) &&
        Boolean(row.BridgeId) &&
        bridges.has(row.BridgeId ?? ""),
    )
    .map((row) => row.Channel ?? "");

  return { local, remote };
}
