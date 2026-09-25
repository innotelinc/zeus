/**
 * Where the WebRTC softphone's WebSocket goes.
 *
 * One rule, in one place, because three surfaces need the same answer and had
 * three different ones: the softphone panel, the Settings field that overrides
 * it, and the compose variable that seeds both. They disagreed in the way that
 * matters — every fallback ended in `:8089/ws`, a *port* that only works when
 * the browser can reach the media container directly. The estate fronts it
 * instead, at `wss://ws.<domain>/ws` behind the reverse proxy, so the port form
 * is wrong on every deployment that terminates TLS in front of the PBX (and it
 * is the form a user's saved Settings value keeps reproducing).
 *
 * So the resolution order is explicit and the fallback is port-less:
 *
 *   1. the operator's saved override (localStorage) — handled by the callers,
 *      since only they can read it and it is meant to win;
 *   2. `FREEPBX_WSS_URL` — the explicit, complete URL;
 *   3. `FREEPBX_WSS_HOST` — a hostname, finished into `wss://<host>/ws`;
 *   4. derived from the dashboard's own hostname: `app.zeus.innotel.us` →
 *      `wss://ws.zeus.innotel.us/ws`.
 *
 * Why the derivation rather than a hardcoded name: this portal is white-label
 * (see `src/lib/resellers.ts`), so a reseller's dashboard is served from its own
 * domain and must get its own socket. The rule is "drop the subdomain label in
 * front of the registrable name and put `ws.` there", which is what the edge
 * actually serves. Anything it cannot derive — a bare IP, `localhost`, an
 * already-`ws.` host — is returned unchanged in the port-less path form, which
 * is still the right answer behind a proxy and is at least visibly wrong rather
 * than silently pointed at a closed port.
 *
 * `NEXT_PUBLIC_FREEPBX_WSS_URL` is deliberately NOT read here. It is inlined
 * into the client bundle at build time, so on the released image it is whatever
 * CI had — the same reason ICE servers moved to the runtime `/api/rtc-config`
 * route (see `src/lib/rtc.ts`). `/api/rtc-config` calls this with the server's
 * environment and hands the browser the answer, so a deployment can change its
 * socket URL without a rebuild.
 */

/**
 * The localStorage key the Settings field writes and the softphone panel reads.
 * Exported so the two cannot drift onto different keys — the field saving to one
 * and the panel reading another is a silent "my setting does nothing".
 */
export const WSS_STORAGE_KEY = "wssUrl";

/**
 * Env this module reads.
 *
 * The index signature is not decoration: without it `process.env` is not
 * assignable here (TypeScript's "no properties in common" for two all-optional
 * object types), and callers would each have to hand-build a narrowed copy.
 */
export interface SoftphoneWssEnv {
  FREEPBX_WSS_URL?: string;
  FREEPBX_WSS_HOST?: string;
  [key: string]: string | undefined;
}

/**
 * The `.ws` host for a dashboard hostname, or the hostname unchanged when it
 * cannot be derived.
 *
 * `app.zeus.innotel.us` → `ws.zeus.innotel.us`. A host that is already the
 * socket's (`ws.zeus.innotel.us`) is left alone rather than doubled. A bare
 * host or IP (`localhost`, `192.168.1.30`) has no subdomain to trade, so it is
 * returned as-is.
 */
export function wssHostFor(dashboardHostname: string): string {
  const host = (dashboardHostname || "").trim().toLowerCase();
  if (!host) return "";
  // A bare address has no label to swap, and prefixing one would invent a name
  // that resolves nowhere.
  if (host.startsWith("ws.")) return host;
  const labels = host.split(".");
  // `localhost`, an IPv4 literal, or a hostname with no room for a prefix.
  if (labels.length < 3 || /^\d+$/.test(labels[0])) return host;
  return ["ws", ...labels.slice(1)].join(".");
}

/**
 * The softphone's WebSocket URL.
 *
 * `dashboardHostname` is what the browser is being served from. Pass `""` on
 * the server when only the environment should decide.
 */
export function softphoneWssUrl(
  env: SoftphoneWssEnv = {},
  dashboardHostname = "",
): string {
  const explicit = (env.FREEPBX_WSS_URL ?? "").trim();
  if (explicit) return explicit;

  const host = (env.FREEPBX_WSS_HOST ?? "").trim();
  if (host) return `wss://${stripPort(host)}/ws`;

  const derived = wssHostFor(dashboardHostname);
  if (derived) return `wss://${derived}/ws`;

  // Nothing to go on. Not a guess at a hostname: this is the form that works
  // when a proxy is in front on the same origin, and it fails loudly instead of
  // dialling a port that is closed on a proxied deployment.
  return "wss://localhost/ws";
}

/** `host:8089` → `host`; the path carries the port-free endpoint now. */
function stripPort(host: string): string {
  return host.replace(/:\d+$/, "");
}

/**
 * The hostname out of an HTTP `Host` header, port removed.
 *
 * `app.zeus.innotel.us:3001` → `app.zeus.innotel.us`. IPv6 literals are kept
 * bracketed rather than split on their own colons.
 */
export function hostnameFromHostHeader(hostHeader: string): string {
  const raw = (hostHeader ?? "").trim();
  if (!raw) return "";
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end === -1 ? raw.toLowerCase() : raw.slice(0, end + 1).toLowerCase();
  }
  return raw.split(":")[0].toLowerCase();
}
