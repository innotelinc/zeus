/**
 * Would a softphone created *now* be handed a media address a LAN phone can
 * actually reach — before any restart?
 *
 * The boot owner converges an address for every endpoint (`pbx/media_address.py`,
 * run by the PBX's entrypoint, and re-derived by the `zeus-pbx-sync` timer), but
 * a phone created *between* boots is covered only by the create path itself
 * (`provisionMediaAddress` in `./pjsip-endpoint`). That path writes nothing when
 * no reachable address is configured: it returns `written: false` and defers to
 * the next boot. Nothing fails — the extension is created, the portal reports
 * success, and the phone's voice and every DTMF digit are lost until the estate
 * restarts. That is the quiet state this check exists to name.
 *
 * It asks the one question the create path asks (`mediaAddressFromEnv`) rather
 * than approximating it, so a green answer is the create path's own
 * precondition. Read-only and env-only: no network, no disk.
 */
import { mediaAddressFromEnv } from "./pjsip-endpoint";

export interface SoftphoneMediaReadiness {
  /** The create path would write an address now. */
  ok: boolean;
  /** The address it would hand a new phone, or `""` when there is none. */
  address: string;
  /** One factual sentence for the health row's healthy state. */
  detail: string;
  /** The cause and its repair, when `ok` is false. */
  error: string;
}

export function softphoneMediaReadiness(): SoftphoneMediaReadiness {
  const address = mediaAddressFromEnv();
  if (address) {
    return {
      ok: true,
      address,
      detail: `a softphone created now is handed media_address=${address}`,
      error: "",
    };
  }
  return {
    ok: false,
    address: "",
    detail: "",
    error:
      "no reachable LAN media address is configured (PJSIP_MEDIA_ADDRESS/LAN_IP), so a " +
      "softphone created now is handed the PBX's own (unreachable) address and loses its " +
      "voice and every DTMF digit until the next boot converges it — set " +
      "PJSIP_MEDIA_ADDRESS on the portal service to the host's LAN address, or let " +
      "pbx/media_address.py run at boot (pbx/README.md)",
  };
}
