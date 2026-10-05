/**
 * What the PBX is actually doing, in the two ways a row of "Offline" hides.
 *
 * The extensions list can only show what the portal last *cached* about an
 * extension: `freepbx_extensions.device_state` is written by AMI events, and
 * when AMI is quiet, or the portal restarted, the column keeps its last value.
 * So "Offline" is shown for an extension that has never sent a REGISTER, for one
 * whose registration the PBX rejected, and for one whose cache is simply stale —
 * three different faults behind one word, and none of them named.
 *
 * `asterisk -rx 'pjsip show contacts'` is the honest answer (the contact exists
 * iff the phone is reachable), and `pjsip show registrations` is its twin for
 * the trunks the estate dials *out* through. Both have AMI equivalents
 * (`PJSIPShowContacts`, `PJSIPShowRegistrationsOutbound`), and this module turns
 * their event streams into the two facts an operator needs:
 *
 *   * a trunk registration the PBX did not accept (`Rejected`, `Stopped`,
 *     anything but `Registered`) — outbound calling is down for every account,
 *     which no extension row can show; and
 *   * an extension with **no contact at all** — the phone has never registered,
 *     which is a different repair from "registered but idle".
 *
 * Pure over the parsed events, so the shapes are pinned without a PBX: the AMI
 * client collects, this decides.
 *
 * One field is deliberately never read. `PJSIPShowRegistrationsOutbound` answers
 * with `AuthDetail` events *interleaved* with the registrations, and those carry
 * the trunk's clear-text `Password`. Only `ObjectType: registration` rows are
 * kept, so the password cannot reach a route response or a log by accident.
 */

/** One outbound registration (a trunk), as Asterisk reports it. */
export interface TrunkRegistration {
  /** The registration's section name, e.g. `voipms-reg`. */
  name: string;
  /** Asterisk's own word: `Registered`, `Rejected`, `Stopped`, … */
  status: string;
  /** The provider the registration points at. */
  serverUri: string;
  /** The PBX did not accept this registration; outbound calling is down. */
  failing: boolean;
}

/** One live contact — a phone that has registered. */
export interface EndpointContact {
  /** The endpoint/AoR it belongs to, which is the extension it serves. */
  extension: string;
  /** Where the contact actually is, e.g. `sip:15000@192.168.1.12:26164`. */
  uri: string;
  /** Asterisk's reachability word: `Reachable`, `Unreachable`, `Unknown`. */
  status: string;
}

/** The one status that means the trunk is up. Everything else is a finding. */
function isRegistered(status: string): boolean {
  return status.trim().toLowerCase() === "registered";
}

/**
 * The trunks, from `PJSIPShowRegistrationsOutbound`'s event stream.
 *
 * `ObjectType: registration` is required rather than merely expected: the same
 * response carries `AuthDetail` events whose `Password` field is the trunk's
 * credential, and this is the guard that keeps it out of the answer.
 */
export function summarizeTrunks(events: Array<Record<string, string>>): TrunkRegistration[] {
  const trunks: TrunkRegistration[] = [];
  for (const event of events) {
    if (event.Event !== "OutboundRegistrationDetail") continue;
    // Belt and braces: the event name already excludes AuthDetail, and the
    // object type keeps a future Asterisk that renames the event from leaking.
    if ((event.ObjectType ?? "").toLowerCase() !== "registration") continue;
    const status = (event.Status ?? "").trim();
    trunks.push({
      name: event.ObjectName ?? "",
      status,
      serverUri: event.ServerUri ?? "",
      failing: status !== "" && !isRegistered(status),
    });
  }
  return trunks;
}

/** The live contacts, from `PJSIPShowContacts`'s `ContactList` events. */
export function summarizeContacts(
  events: Array<Record<string, string>>,
): EndpointContact[] {
  const contacts: EndpointContact[] = [];
  for (const event of events) {
    if (event.Event !== "ContactList") continue;
    const extension = (event.Endpoint ?? "").trim();
    if (!extension) continue;
    contacts.push({
      extension,
      uri: event.Uri ?? "",
      status: event.Status ?? "",
    });
  }
  return contacts;
}

/**
 * The endpoints the PBX defines, from `PJSIPShowEndpoints`'s `EndpointList`
 * events.
 *
 * Only the names matter: they are the join key against the portal's rows. An
 * endpoint here is something a phone *can* register against — which is exactly
 * what a mirror row is not guaranteed to be.
 */
export function summarizeEndpoints(
  events: Array<Record<string, string>>,
): string[] {
  const names: string[] = [];
  for (const event of events) {
    if (event.Event !== "EndpointList") continue;
    const name = (event.ObjectName ?? "").trim();
    if (name) names.push(name);
  }
  return names;
}

/**
 * The extensions a phone can register against — the ones the PBX has an endpoint
 * for.
 *
 * Without this, every mirror row is judged as if it were a phone, and the rows
 * that are not phones say so forever. The four fax service lines (`3291`–`3294`)
 * are IAX2 modems: no contact will ever exist for them, so the panel named them
 * under "no registration" on every single load — a permanent false positive,
 * which is how an operator learns to ignore a report.
 *
 * A row the PBX has no endpoint for is not a phone that failed to register; it
 * is not a phone. An extension that is *supposed* to have a phone but has no
 * endpoint at all is a different fault, and one the PBX's own configuration
 * already states.
 */
export function phoneExtensions(
  extensionIds: string[],
  endpoints: string[],
): string[] {
  const have = new Set(endpoints);
  return extensionIds.filter((id) => have.has(id));
}

/** The registrations the PBX did not accept — the ones that cost a call. */
export function failingTrunks(trunks: TrunkRegistration[]): TrunkRegistration[] {
  return trunks.filter((trunk) => trunk.failing);
}

/**
 * The extensions with no contact, so no phone is registered against them.
 *
 * The input is the set of extensions to judge (the portal's own rows) rather
 * than every endpoint on the box: a trunk's endpoint and a hand-built one are
 * not extensions a tenant expects to see, and reporting them would bury the one
 * that matters. An extension is "unregistered" only when *no* contact names it —
 * an AoR may hold several contacts across devices.
 */
export function withoutContacts(
  extensionIds: string[],
  contacts: EndpointContact[],
): string[] {
  const have = new Set(contacts.map((contact) => contact.extension));
  return extensionIds.filter((id) => !have.has(id));
}
