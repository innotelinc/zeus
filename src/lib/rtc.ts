/**
 * ICE configuration for the softphone, resolved on the server.
 *
 * WHY THIS IS NOT A NEXT_PUBLIC_* READ IN THE COMPONENT. The softphone used to
 * build its ICE servers from process.env.NEXT_PUBLIC_TURN_*, which the bundler
 * inlines at build time — and the deployed portal image is built in CI, where
 * this host's TURN hostname and credentials do not exist. The shipped bundle
 * therefore carries no TURN url at all, so browsers fell back to public STUN,
 * which fails behind the symmetric NAT most callers sit behind: the call
 * connects, then carries no audio. Resolving the same values here instead
 * means the container's own .env decides, so repointing coturn — or switching
 * it to `turns:` — is an env change and a restart, not an image rebuild.
 *
 * The credentials are coturn's long-term pair, not per-user secrets: every
 * signed-in user gets the same ones, which is why the route serving this sits
 * behind requireUser rather than being public.
 */

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Public STUN, so a browser still gathers a server-reflexive candidate. */
const STUN: IceServer = { urls: "stun:stun.l.google.com:19302" };

/**
 * TURN_SERVER may list more than one URL, comma- or space-separated, and the
 * browser tries them in order. The estate lists `turn:` first (UDP, lower
 * latency) and `turns:` second (TCP, for networks that block UDP), which is
 * also why a list is accepted rather than a single url.
 *
 * Both spellings are accepted for each key: TURN_* is what the compose file
 * and coturn itself use, NEXT_PUBLIC_TURN_* is the older portal-side name.
 */
function turnUrls(env: NodeJS.ProcessEnv): string[] {
  return (env.TURN_SERVER ?? env.NEXT_PUBLIC_TURN_SERVER ?? "")
    .split(/[\s,]+/)
    .map((url) => url.trim())
    .filter(Boolean);
}

export function buildIceServers(env: NodeJS.ProcessEnv = process.env): IceServer[] {
  const servers: IceServer[] = [STUN];

  const urls = turnUrls(env);
  if (urls.length === 0) return servers;

  const username = env.TURN_USERNAME ?? env.NEXT_PUBLIC_TURN_USERNAME;
  const credential = env.TURN_CREDENTIAL ?? env.NEXT_PUBLIC_TURN_CREDENTIAL;

  // Credentials are optional: a TURN url without them still relays for servers
  // configured with no auth (or with per-user credentials supplied elsewhere),
  // and pushing the entry regardless is what lets a half-configured install
  // show up as "TURN attempted" in the browser's ICE stats instead of silent.
  servers.push(username && credential ? { urls, username, credential } : { urls });
  return servers;
}
