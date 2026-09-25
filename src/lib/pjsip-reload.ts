/**
 * Make a written PJSIP fragment live — only when it is already live.
 *
 * The reload is what turns a fragment on disk into an endpoint Asterisk will
 * answer on, so every writer of `/etc/asterisk/pjsip_ext_<ext>.conf` wants it
 * and both of them (create, and the repair path) must apply the same rule. That
 * rule is the whole reason this is one function rather than a line in each
 * caller:
 *
 * **Only reload when an operator-owned file already includes the fragment.**
 * Reloading a fragment that nothing loads is pointless; reloading one that is
 * loaded *some other way* is how a duplicate `[<ext>]` — the object id FreePBX
 * generates for the same extension — gets activated, and a duplicate object id
 * makes sorcery refuse the entire PJSIP configuration. A reload is cheap;
 * losing every endpoint on the box is not.
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
