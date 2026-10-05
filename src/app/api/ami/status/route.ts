import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-helpers";
import { getAmiClient } from "@/lib/ami";
import db from "@/lib/db";
import { summarizeContacts, withoutContacts } from "@/lib/pbx-health";

export const dynamic = "force-dynamic";

/**
 * `freepbx_extensions.device_state` is what the portal last *cached*; it cannot
 * tell an extension that has never registered from one that is merely idle, so
 * a row reads "Offline" for both. `?contacts=1` additionally asks the PBX
 * itself (`PJSIPShowContacts`) which extensions have a live contact, and
 * answers `unregistered` — the rows where *no* phone is registered at all.
 *
 * Opt-in rather than always: the shell polls this every 15s for the AMI light
 * alone, and a list action per poll would spend the PBX's time on a fact only
 * the extensions screen shows. `contacts_known: false` means the read failed
 * (AMI down, action timeout) — the caller must then show nothing rather than
 * "no contact", because unknown is not absent.
 */
export async function GET(request: Request) {
  const { user, error } = await requireUser();
  if (error) return error;

  const wantsContacts = new URL(request.url).searchParams.get("contacts") === "1";

  const client = getAmiClient();
  const connected = client.isConnected;

  // Get device states for this user's extensions
  const extensions = db
    .prepare(
      "SELECT extension_id, device_state FROM freepbx_extensions WHERE user_id = ?",
    )
    .all(user.id) as Array<{ extension_id: string; device_state: string }>;

  // Get active call count
  const activeCount = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM call_history WHERE user_id = ? AND status = 'answered'",
      )
      .get(user.id) as { c: number }
  ).c;

  // Get today's call count
  const todayCount = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM call_history WHERE user_id = ? AND created_at >= date('now')",
      )
      .get(user.id) as { c: number }
  ).c;

  // Judge only this user's own extensions: the PBX's contact list also names
  // trunk aoRs and hand-built endpoints, which are not rows on this screen.
  let contactsKnown = false;
  let unregistered: string[] = [];
  if (wantsContacts && connected) {
    try {
      const contacts = summarizeContacts(await client.listContacts());
      unregistered = withoutContacts(
        extensions.map((ext) => ext.extension_id),
        contacts,
      );
      contactsKnown = true;
    } catch {
      // Leave `contactsKnown` false: a failed read must not render as "no
      // contact" for every row.
    }
  }

  return NextResponse.json({
    ami_connected: connected,
    contacts_known: contactsKnown,
    unregistered,
    extensions,
    active_calls: activeCount,
    today_calls: todayCount,
  });
}
