import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-helpers";
import { getAmiClient } from "@/lib/ami";
import db from "@/lib/db";
import {
  phoneExtensions,
  summarizeContacts,
  summarizeEndpoints,
  withoutContacts,
} from "@/lib/pbx-health";

export const dynamic = "force-dynamic";

/**
 * `freepbx_extensions.device_state` is what the portal last *cached*; it cannot
 * tell an extension that has never registered from one that is merely idle, so
 * a row reads "Offline" for both. `?contacts=1` additionally asks the PBX
 * itself (`PJSIPShowContacts`) which extensions have a live contact, and
 * answers `unregistered` — the rows where *no* phone is registered at all.
 *
 * Two reads answer it, and both are needed. `PJSIPShowContacts` says which
 * extensions have a phone on them; `PJSIPShowEndpoints` says which extensions
 * are phones *at all*. Without the second, every mirror row is judged as one —
 * and the fax service lines (`3291`–`3294`) are IAX2 modems, so they would be
 * named as unregistered on every load, forever.
 *
 * Opt-in rather than always: the shell polls this every 15s for the AMI light
 * alone, and list actions per poll would spend the PBX's time on a fact only
 * the extensions screen shows. `contacts_known: false` means the judgement could
 * not be made (AMI down, action timeout) — the caller must then show nothing
 * rather than "no contact", because unknown is not absent.
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

  // Judge only this user's own extensions, and only the ones that are phones: the
  // PBX's contact list also names trunk AoRs and hand-built endpoints, and its
  // endpoint list is what separates a phone that has not registered from a line
  // (the fax modems) that never could.
  let contactsKnown = false;
  let unregistered: string[] = [];
  if (wantsContacts && connected) {
    try {
      const [contactEvents, endpointEvents] = await Promise.all([
        client.listContacts(),
        client.listEndpoints(),
      ]);
      unregistered = withoutContacts(
        phoneExtensions(
          extensions.map((ext) => ext.extension_id),
          summarizeEndpoints(endpointEvents),
        ),
        summarizeContacts(contactEvents),
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
