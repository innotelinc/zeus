/**
 * Asterisk REST Interface (ARI) client — the one call path AMI does not have.
 *
 * AMI can list channels, hang them up and originate calls, but it cannot *hold*
 * one. There is no `MusicOnHold` (or `StopMusicOnHold`) action in Asterisk's
 * manager action list — `manager show commands` carries none in any release
 * from 12 through 22, and asking for one is answered with `Response: Error`.
 * ARI is where the operation lives:
 *
 *     POST   /ari/channels/{channelId}/hold   — hold a channel (MOH to it)
 *     DELETE /ari/channels/{channelId}/hold   — remove a channel from hold
 *
 * Private Hold is exactly that pair applied to the channel *bridged with* the
 * extension (holding the extension's own channel would send the music back to
 * the operator, not to the caller — see `listChannelDetails` in `ami.ts`).
 *
 * Required env vars:
 *   ASTERISK_ARI_BASE_URL – ARI HTTP origin, e.g. `http://<LAN IP>:8088`
 *   ASTERISK_ARI_USERNAME – ARI user (pbx.env FREEPBX_ARI_USER, default pbxportal)
 *   ASTERISK_ARI_PASSWORD – ARI secret (pbx.env FREEPBX_ARI_SECRET)
 */

export interface AriConfig {
  baseUrl: string;
  username: string;
  password: string;
}

/** The fields of an ARI `Bridge` this file reads. */
export interface AriBridge {
  id?: string;
  bridge_type?: string;
  /** Present on a bridge detail read; not guaranteed on a list read. */
  channels?: string[];
}

/**
 * How long ARI may take. The PBX is on the LAN and holds are interactive: an
 * operator staring at a spinner learns more from a fast failure than a slow
 * success.
 */
const TIMEOUT_MS = 5000;

function config(): AriConfig {
  return {
    // Trailing slashes would double up on the `/ari` we append.
    baseUrl: (process.env.ASTERISK_ARI_BASE_URL ?? "").replace(/\/+$/, ""),
    username: process.env.ASTERISK_ARI_USERNAME ?? "",
    password: process.env.ASTERISK_ARI_PASSWORD ?? "",
  };
}

/** True only when all three values a hold needs are present. */
export function ariConfigured(cfg: AriConfig = config()): boolean {
  return cfg.baseUrl !== "" && cfg.username !== "" && cfg.password !== "";
}

/**
 * The ARI URL for holding (or releasing) one channel.
 *
 * ARI resolves `channelId` with `ast_channel_get_by_name()`, so the channel
 * *name* the AMI `Status` event carries (`PJSIP/4132643964-0000000a`) is as
 * valid as a uniqueid. It is a single path segment, so the slashes must be
 * percent-encoded or the route never matches.
 */
export function holdUrl(channel: string, cfg: AriConfig = config()): string {
  return `${cfg.baseUrl}/ari/channels/${encodeURIComponent(channel)}/hold`;
}

function authHeader(cfg: AriConfig): string {
  return `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64")}`;
}

/** GET one ARI resource, with the portal's own ARI credentials. */
async function ariGet<T>(path: string, cfg: AriConfig): Promise<T> {
  const response = await fetch(`${cfg.baseUrl}${path}`, {
    headers: { Authorization: authHeader(cfg), Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200).trim();
    throw new Error(
      `ARI GET ${path} failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  return (await response.json().catch(() => null)) as T;
}

/**
 * Whether Private Hold can reach ARI at all, as `""` (fine) or the reason why
 * not. Never throws: this is what a diagnostics surface reports, so a failure
 * has to be an answer rather than an exception.
 *
 * It probes `/ari/asterisk/info`, which is authenticated — the difference
 * between "nothing is listening on 8088" and "something is, but it rejected
 * these credentials" is the whole point of a reachability check, and an
 * unauthenticated probe cannot tell them apart.
 */
export async function ariReachable(
  cfg: AriConfig = config(),
  timeoutMs: number = TIMEOUT_MS,
): Promise<string> {
  if (!ariConfigured(cfg)) {
    return (
      "not configured — set ASTERISK_ARI_BASE_URL, ASTERISK_ARI_USERNAME and " +
      "ASTERISK_ARI_PASSWORD"
    );
  }
  try {
    const response = await fetch(`${cfg.baseUrl}/ari/asterisk/info`, {
      headers: { Authorization: authHeader(cfg), Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return "";
    if (response.status === 401 || response.status === 403) {
      return (
        `ARI rejected the portal's credentials (HTTP ${response.status}) — check ` +
        "ASTERISK_ARI_USERNAME/ASTERISK_ARI_PASSWORD against the PBX's ari.conf"
      );
    }
    return `ARI answered HTTP ${response.status} at ${cfg.baseUrl}/ari/asterisk/info`;
  } catch (e) {
    return `ARI unreachable at ${cfg.baseUrl}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * The channels the PBX is holding right now.
 *
 * Asterisk holds a channel by parking it in a *holding* bridge with a music-on-
 * hold channel attached (`res/res_stasis.c` — the hold control "creates, pushes,
 * and links a channel for playing music on hold to bridge"), and ARI lists
 * those bridges. So membership here is the **PBX's** answer to "is this caller
 * on hold", not the console's memory of it: a hold engaged from a desk phone, a
 * carrier, or another operator's screen shows up, and a hold *released* anywhere
 * stops showing up. That is the whole reason to read it instead of tracking it.
 */
export async function listHoldingChannels(cfg: AriConfig = config()): Promise<Set<string>> {
  if (!ariConfigured(cfg)) {
    throw new Error(
      "ARI is not configured — set ASTERISK_ARI_BASE_URL, ASTERISK_ARI_USERNAME " +
        "and ASTERISK_ARI_PASSWORD (see scripts/pbx.env.example) to read hold state",
    );
  }
  const bridges = await ariGet<AriBridge[]>("/ari/bridges?type=holding", cfg);
  const held = new Set<string>();
  for (const bridge of bridges ?? []) {
    // A list read may omit `channels` (the field is on the Bridge model, but a
    // filtered list is not required to populate it), so read the bridge itself
    // when it is missing rather than reporting "nobody is held" from silence.
    const channels =
      bridge.channels ??
      (bridge.id
        ? (await ariGet<AriBridge>(`/ari/bridges/${encodeURIComponent(bridge.id)}`, cfg))
            .channels
        : undefined);
    for (const channel of channels ?? []) held.add(channel);
  }
  return held;
}

/**
 * Hold a channel, or take it off hold. Throws with the PBX's own reason — a
 * Private Hold the operator cannot see failing is worse than a refused one.
 */
export async function setChannelHold(
  channel: string,
  hold: boolean,
  cfg: AriConfig = config(),
): Promise<void> {
  if (!ariConfigured(cfg)) {
    throw new Error(
      "ARI is not configured — set ASTERISK_ARI_BASE_URL, ASTERISK_ARI_USERNAME " +
        "and ASTERISK_ARI_PASSWORD (see scripts/pbx.env.example) to use Private Hold",
    );
  }

  const response = await fetch(holdUrl(channel, cfg), {
    method: hold ? "POST" : "DELETE",
    headers: {
      Authorization: authHeader(cfg),
      "Content-Type": "application/json",
    },
    // ARI's hold endpoint takes no arguments; an empty JSON object is the
    // shape its generated handler expects for a POST.
    body: hold ? "{}" : undefined,
    cache: "no-store",
  });

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200).trim();
    throw new Error(
      `ARI ${hold ? "hold" : "unhold"} failed for ${channel} (HTTP ${response.status})` +
        (detail ? `: ${detail}` : ""),
    );
  }
}
