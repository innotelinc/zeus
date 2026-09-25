/**
 * Make a written PJSIP fragment live — only when it is already live.
 *
 * The reload is what turns the settings on disk into a live endpoint, so both
 * writers (create, and the repair path) want it and must apply the same rule.
 * That rule is the whole reason this is one function rather than a line in each
 * caller:
 *
 * **Only reload when our settings are in the file FreePBX loads.** Since the
 * endpoint decision (`docs/voice-convergence.md` §11.5) that is
 * `pjsip.endpoint_custom_post.conf`, which FreePBX includes itself — so
 * `state.provisioned` is exactly "Asterisk will read this at the next load".
 * Reloading when it is not (a write that failed, an unmounted config directory)
 * is a module reload that changes nothing. The old fragment shape's hazard —
 * reloading a second `[<ext>]` into the load tree and making sorcery refuse the
 * whole PJSIP configuration — is gone with it, because nothing here defines an
 * object any more: `[<ext>](+)` appends to FreePBX's.
 */
import { getAmiClient } from "./ami";
import type { SoftphoneState } from "./pjsip-endpoint";

export async function reloadPjsipIfLive(state: SoftphoneState): Promise<boolean> {
  if (!state.provisioned) return false;
  const ami = getAmiClient();
  if (!ami.isConnected) return false;
  await ami
    .sendAction({ Action: "Command", Command: "module reload res_pjsip.so" })
    .catch(() => {});
  return true;
}
