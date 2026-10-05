import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getAmiClient } from "@/lib/ami";
import db from "@/lib/db";
import {
  failingTrunks,
  summarizeContacts,
  summarizeTrunks,
  withoutContacts,
} from "@/lib/pbx-health";

export const dynamic = "force-dynamic";

/**
 * The live PBX picture an operator needs when a row says "Offline".
 *
 * The extensions list can only show what the portal cached about an extension
 * (`freepbx_extensions.device_state`, written by AMI events). That cache cannot
 * tell an extension that has *never* registered from one whose registration was
 * refused from one whose cache is merely stale — and it cannot see the trunks at
 * all, so a rejected trunk shows up only as calls that will not leave. This
 * route asks the PBX directly (`PJSIPShowContacts`,
 * `PJSIPShowRegistrationsOutbound`) and answers with the two facts the cache
 * cannot: which trunks are not registered, and which extensions have no contact.
 *
 * Admin-only, like the reload/restart beside it: a trunk outage is estate-wide.
 * AMI being down is reported as `ami_connected: false` with empty lists rather
 * than an error, because "the portal cannot see the PBX" is itself the finding —
 * and the panel says so instead of showing a stale green.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (user.role !== "admin") {
    return NextResponse.json(
      { error: "Admin access required — this reports the whole PBX" },
      { status: 403 },
    );
  }

  const ami = getAmiClient();
  if (!ami.isConnected) {
    return NextResponse.json({
      ami_connected: false,
      trunks: [],
      failing_trunks: [],
      contacts: [],
      registered_extensions: [],
      unregistered_extensions: [],
    });
  }

  // Both reads are best-effort and independent: a box that answers one and not
  // the other still has something worth showing, so neither failure blanks the
  // other. An empty answer is "nothing to report", not "the read failed".
  const [contactEvents, trunkEvents] = await Promise.all([
    ami.listContacts().catch(() => []),
    ami.listOutboundRegistrations().catch(() => []),
  ]);
  const contacts = summarizeContacts(contactEvents);
  const trunks = summarizeTrunks(trunkEvents);

  // The extensions to judge are the portal's own rows, not every endpoint on the
  // box: a trunk's endpoint and a hand-built one are not extensions a tenant
  // expects to see here (see `withoutContacts`).
  const extensionIds = (
    db.prepare("SELECT DISTINCT extension_id FROM freepbx_extensions").all() as Array<{
      extension_id: string;
    }>
  ).map((row) => row.extension_id);

  const registered = contacts
    .map((contact) => contact.extension)
    .filter((extension, index, all) => all.indexOf(extension) === index);

  return NextResponse.json({
    ami_connected: true,
    trunks,
    failing_trunks: failingTrunks(trunks),
    contacts,
    registered_extensions: registered,
    unregistered_extensions: withoutContacts(extensionIds, contacts),
  });
}
