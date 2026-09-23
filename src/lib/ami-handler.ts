/**
 * AMI event handler — maps raw Asterisk AMI events to database records.
 *
 * Handles:
 *   - Newchannel / Hangup → call_history entries (CDR)
 *   - VarSet / Newexten → voice_calls: the call envelope, and every hand-off
 *     (P4 — one record, one id, written by the switch rather than by an agent)
 *   - DeviceStateChange → freepbx_extensions.device_state updates
 *   - Cdr → finalized call records with duration
 */

import { randomUUID } from "node:crypto";
import db from "./db";
import { getAmiClient, type AmiEvent, type AmiClient } from "./ami";
import { SPAN_KIND, startSpan } from "./otel";
import {
  concludeCall,
  handoffFromContext,
  noteHandoff,
  recordEnvelope,
  type EnvelopeFacts,
} from "./voice-calls";

// ─── In-memory tracking ───

interface TrackedCall {
  uniqueId: string;
  channel: string;
  callerIdNum: string;
  callerIdName: string;
  connectedLineNum: string;
  direction: "inbound" | "outbound" | "internal";
  extensionId: string | null;
  startTime: number;
  answerTime: number | null;
  bridgedChannel: string | null;
  dbRecordId: string | null;
}

// Map uniqueId → call tracking info
const activeCalls = new Map<string, TrackedCall>();

// ─── Extension helper ───

function findExtensionByChannel(channel: string): string | null {
  // Channel formats: PJSIP/101-0000001a, SIP/101-0000001a, or
  // Local/101@from-internal-0000001a (the '@' precedes the context)
  const match = channel.match(/\/(\d+)[@\/-]/);
  if (!match) return null;

  const ext = db
    .prepare("SELECT extension_id FROM freepbx_extensions WHERE extension_id = ?")
    .get(match[1]) as { extension_id: string } | undefined;

  return ext?.extension_id ?? null;
}

function findUserByExtension(extId: string): string | null {
  const row = db
    .prepare("SELECT user_id FROM freepbx_extensions WHERE extension_id = ?")
    .get(extId) as { user_id: string } | undefined;
  return row?.user_id ?? null;
}

function determineDirection(
  channel: string,
  context: string | undefined,
): "inbound" | "outbound" | "internal" {
  // Outbound channels typically go through the "from-internal" context
  if (context === "from-internal") return "outbound";
  // Internal calls stay within the PBX
  if (context?.startsWith("from-internal")) return "internal";
  // Inbound calls come from the trunk
  if (channel.toLowerCase().includes("pjsip") || channel.toLowerCase().includes("sip")) {
    // Check if the channel is initiating (outbound) or receiving (inbound)
    if (context === "from-trunk" || context === "from-pstn") return "inbound";
  }
  // Default: if it's going out through a trunk context
  if (context?.includes("trunk") || context?.includes("outbound")) return "outbound";
  return "inbound";
}

// ─── Event handlers ───

function handleNewchannel(event: AmiEvent): void {
  const uniqueId = event.Uniqueid;
  const channel = event.Channel;
  const callerIdNum = event.CallerIDNum ?? "";
  const callerIdName = event.CallerIDName ?? "";
  const connectedLineNum = event.ConnectedLineNum ?? "";
  const context = event.Context;
  const ext = findExtensionByChannel(channel);

  const direction = determineDirection(channel, context);

  // Create a tentative call_history record immediately — but only when the
  // call maps to a portal user (call_history.user_id is NOT NULL). Calls on
  // channels that don't resolve to a known extension are still tracked
  // in-memory so Hangup/CDR events can update state, just not persisted.
  const userId = ext ? findUserByExtension(ext) : null;
  const dbId = userId ? randomUUID() : null;

  if (dbId) {
    db.prepare(
      `INSERT INTO call_history (id, user_id, extension_id, direction, caller_number, callee_number, caller_name, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ringing')`,
    ).run(
      dbId,
      userId,
      ext,
      direction,
      callerIdNum || "unknown",
      connectedLineNum || "unknown",
      callerIdName || null,
    );
  }

  activeCalls.set(uniqueId, {
    uniqueId,
    channel,
    callerIdNum,
    callerIdName,
    connectedLineNum,
    direction,
    extensionId: ext,
    startTime: Date.now(),
    answerTime: null,
    bridgedChannel: null,
    dbRecordId: dbId,
  });
}

/**
 * The envelope variables the dialplan stamps, and the `voice_calls` column each
 * one fills (see `pbx/ava_routing.py`).
 *
 * Keyed on the variable name because AMI reports every `Set()` as its own
 * `VarSet` event: one call arrives here several times, in dialplan order, and
 * `recordEnvelope` is built to fill blanks rather than overwrite — so the last
 * event cannot erase what an earlier one established.
 *
 * The row is keyed on `Uniqueid`, which is also what `AI_CALL_ID` is defined as
 * (`AI_CALL_ID = ${UNIQUEID}`, D2). That invariant is what makes `Hangup` able
 * to conclude the row this handler opened; a deployment that changes the
 * definition has to change this line too, and the dialplan fragment says so.
 */
const ENVELOPE_VARS: Record<string, keyof Omit<EnvelopeFacts, "call_id">> = {
  AI_ACCOUNT: "account_id",
  AI_AGENT: "agent_slug",
  ZEUS_CAPSTONE_TARGET: "capstone_binding",
  FROM_DID: "did",
};

function handleVarSet(event: AmiEvent): void {
  const callId = event.Uniqueid ?? "";
  const field = ENVELOPE_VARS[event.Variable ?? ""];
  if (!callId || !field) return;
  recordEnvelope({ call_id: callId, [field]: event.Value ?? "" });
}

/**
 * A call entering another agent's context is a hand-off, on the switch's own
 * evidence.
 *
 * This is where the two products share one record without either of them
 * reporting anything: the dialplan moves the channel, AMI sees the context, and
 * the row records the hop. It is also why the record survives an agent that dies
 * mid-interview — the switch is still there to say where the call was.
 */
function handleNewexten(event: AmiEvent): void {
  const target = handoffFromContext(event.Context ?? "");
  if (!target) return;
  noteHandoff(event.Uniqueid ?? "", target);
}

function handleBridge(event: AmiEvent): void {
  const id1 = event.Uniqueid1;
  const id2 = event.Uniqueid2;
  const state = event.Bridgestate; // "Link" or "Unlink"

  if (state === "Link") {
    // Call is answered — update start time
    const call1 = activeCalls.get(id1);
    const call2 = activeCalls.get(id2);

    const answeredCall = call1 ?? call2;
    if (answeredCall && !answeredCall.answerTime) {
      answeredCall.answerTime = Date.now();
      answeredCall.bridgedChannel = call1?.uniqueId === answeredCall.uniqueId
        ? call2?.channel ?? null
        : call1?.channel ?? null;

      // Update DB: mark as answered
      if (answeredCall.dbRecordId) {
        db.prepare(
          "UPDATE call_history SET status = 'answered' WHERE id = ?",
        ).run(answeredCall.dbRecordId);
      }
    }
  }
}

function handleHangup(event: AmiEvent): void {
  const uniqueId = event.Uniqueid;
  const cause = event.Cause ?? "0";

  // Concluded before the in-memory guard: the call record is written from
  // events this map does not track (a `VarSet` can arrive for a channel whose
  // `Newchannel` we never saw), and a call that ended is a call that ended
  // whether or not this process watched it start.
  concludeCall(uniqueId);

  const call = activeCalls.get(uniqueId);
  if (!call) return;

  const endTime = Date.now();
  const duration = Math.floor(
    ((call.answerTime ?? call.startTime) ? endTime - (call.answerTime ?? call.startTime) : 0) / 1000,
  );

  const status = call.answerTime
    ? "completed"
    : cause === "16"
      ? "no-answer"
      : cause === "17"
        ? "busy"
        : "failed";

  // Update the call_history record
  if (call.dbRecordId) {
    db.prepare(
      `UPDATE call_history
       SET duration_seconds = ?, status = ?
       WHERE id = ?`,
    ).run(duration, status, call.dbRecordId);
  }

  activeCalls.delete(uniqueId);
}

function handleCdr(event: AmiEvent): void {
  // CDR provides final billing-quality data
  const uniqueId = event.Uniqueid;
  const src = event.Source ?? event.Src ?? "";
  const dst = event.Destination ?? event.Dst ?? "";
  const duration = parseInt(event.BillableSeconds ?? event.Duration ?? "0", 10);
  const disposition = event.Disposition ?? "ANSWERED";

  // One span per CDR write, carrying the Asterisk uniqueid as the call id —
  // the same id the dialplan stamps as AI_CALL_ID and Capstone fetches
  // context with. That is what turns "the CDR was missing for nine days"
  // (docs/ava-capstone-convergence.md §2.7) from a discovery into a symptom:
  // the trace shows the event arriving and the row it did or did not update.
  // A no-op span when tracing is off, so the hot path is unchanged.
  const span = startSpan("ami.cdr", {
    kind: SPAN_KIND.INTERNAL,
    attributes: {
      "zeus.call_id": uniqueId || undefined,
      "zeus.cdr.disposition": disposition,
      "zeus.cdr.src": src,
      "zeus.cdr.dst": dst,
    },
  });
  span.setAttribute("zeus.cdr.billable_seconds", Number.isFinite(duration) ? duration : undefined);

  const call = activeCalls.get(uniqueId);
  if (call?.dbRecordId) {
    span.setAttribute("zeus.cdr.persisted", true);
    const status = disposition === "ANSWERED"
      ? "completed"
      : disposition === "NO ANSWER"
        ? "no-answer"
        : disposition === "BUSY"
          ? "busy"
          : "failed";

    db.prepare(
      `UPDATE call_history
       SET caller_number = CASE WHEN ? != '' THEN ? ELSE caller_number END,
           callee_number = CASE WHEN ? != '' THEN ? ELSE callee_number END,
           duration_seconds = CASE WHEN ? > 0 THEN ? ELSE duration_seconds END,
           status = ?
       WHERE id = ?`,
    ).run(src, src, dst, dst, duration, duration, status, call.dbRecordId);
    span.setAttribute("zeus.cdr.status", status);
  } else {
    // A CDR for a channel this process never tracked, or an event with no
    // uniqueid: the record it would update does not exist. Recording the fact
    // is the point — silently doing nothing is how the odbc outage hid.
    span.setAttribute("zeus.cdr.persisted", false);
  }
  span.end();
}

function handleDeviceStateChange(event: AmiEvent): void {
  const device = event.Device ?? "";
  const state = event.State ?? "UNKNOWN";

  // Parse device: "PJSIP/101" → extension "101"
  const match = device.match(/\/(\d+)$/);
  if (!match) return;

  const extId = match[1];

  // Map AMI state to our device_state
  const mappedState = mapDeviceState(state);

  db.prepare(
    "UPDATE freepbx_extensions SET device_state = ?, updated_at = datetime('now') WHERE extension_id = ? AND device_state != ?",
  ).run(mappedState, extId, mappedState);
}

function handleExtensionStatus(event: AmiEvent): void {
  const ext = event.Exten ?? "";
  const statusText = event.StatusText ?? event.Status ?? "";

  const mappedState = mapAmiExtensionStatus(statusText);

  db.prepare(
    "UPDATE freepbx_extensions SET device_state = ?, updated_at = datetime('now') WHERE extension_id = ? AND device_state != ?",
  ).run(mappedState, ext, mappedState);
}

// ─── State mapping helpers ───

function mapDeviceState(amiState: string): string {
  const map: Record<string, string> = {
    NOT_INUSE: "idle",
    INUSE: "in-call",
    BUSY: "busy",
    UNAVAILABLE: "offline",
    RINGING: "ringing",
    INVALID: "offline",
    ONHOLD: "on-hold",
  };
  return map[amiState] ?? "unknown";
}

function mapAmiExtensionStatus(statusText: string): string {
  const lower = statusText.toLowerCase();
  if (lower.includes("idle") || lower.includes("not in use")) return "idle";
  if (lower.includes("in use") || lower.includes("ringing")) return "in-call";
  if (lower.includes("busy")) return "busy";
  if (lower.includes("unavailable") || lower.includes("unreachable")) return "offline";
  if (lower.includes("on hold")) return "on-hold";
  return "unknown";
}

// ─── Init ───

let initialized = false;

export function initAmiHandler(): void {
  if (initialized) return;
  initialized = true;

  const client = getAmiClient();

  client.onEvent((event) => {
    try {
      switch (event.Event) {
        case "Newchannel":
          handleNewchannel(event);
          break;
        case "VarSet":
          handleVarSet(event);
          break;
        case "Newexten":
          handleNewexten(event);
          break;
        case "Bridge":
        case "BridgeEnter":
          handleBridge(event);
          break;
        case "Hangup":
        case "HangupRequest":
          handleHangup(event);
          break;
        case "Cdr":
          handleCdr(event);
          break;
        case "DeviceStateChange":
          handleDeviceStateChange(event);
          break;
        case "ExtensionStatus":
          handleExtensionStatus(event);
          break;
      }
    } catch (e) {
      console.error("AMI handler error:", e);
    }
  });

  console.log("AMI: Event handlers registered");
}

/** Query the current device state from Asterisk for an extension. */
export async function queryExtensionState(
  client: AmiClient,
  extensionId: string,
): Promise<string | null> {
  try {
    const result = await client.sendAction({
      Action: "ExtensionState",
      Exten: extensionId,
      Context: "from-internal",
    });
    return mapAmiExtensionStatus(result.StatusText ?? result.Status ?? "");
  } catch {
    return null;
  }
}

/** Query PJSIP endpoint status via AMI for extensions not covered by hints.
 *  PJSIPShowEndpoint returns data as EndpointDetail events, not key-value pairs. */
async function queryPjsipEndpointState(
  client: AmiClient,
  extensionId: string,
): Promise<string | null> {
  try {
    let deviceState: string | null = null;
    let complete = false;

    const unsubscribe = client.onEvent((event) => {
      if (event.Event === "EndpointDetail" && event.ObjectName === extensionId) {
        if (event.DeviceState) {
          deviceState = mapAmiExtensionStatus(event.DeviceState);
        }
      }
      if (event.Event === "EndpointDetailComplete") {
        complete = true;
        unsubscribe();
      }
    });

    await client.sendAction({
      Action: "PJSIPShowEndpoint",
      Endpoint: extensionId,
    });

    // Wait up to 5s for EndpointDetailComplete
    const start = Date.now();
    while (!complete && Date.now() - start < 5_000) {
      await new Promise((r) => setTimeout(r, 50));
    }

    if (!complete) {
      unsubscribe();
    }

    return deviceState;
  } catch {
    return null;
  }
}

/** Refresh device state for all extensions from live Asterisk data.
 *  Called on AMI connect so states never stay "unknown" after startup. */
export async function refreshAllExtensionStates(client: AmiClient): Promise<void> {
  const extensions = db
    .prepare("SELECT extension_id FROM freepbx_extensions")
    .all() as Array<{ extension_id: string }>;

  for (const { extension_id } of extensions) {
    // Try hint-based query first (works for FreePBX-provisioned extensions)
    let state = await queryExtensionState(client, extension_id);

    // Fall back to PJSIP endpoint query for manually created endpoints
    if (!state || state === "unknown") {
      state = await queryPjsipEndpointState(client, extension_id);
    }

    if (state && state !== "unknown") {
      db.prepare(
        "UPDATE freepbx_extensions SET device_state = ?, updated_at = datetime('now') WHERE extension_id = ? AND device_state != ?",
      ).run(state, extension_id, state);
    }
  }
}
