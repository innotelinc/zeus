/**
 * AMI event handler — maps raw Asterisk AMI events to database records.
 *
 * Handles:
 *   - Newchannel / Hangup → call_history entries (CDR)
 *   - DeviceStateChange → freepbx_extensions.device_state updates
 *   - Cdr → finalized call records with duration
 */

import { randomUUID } from "node:crypto";
import db from "./db";
import { getAmiClient, type AmiEvent, type AmiClient } from "./ami";

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
  // Channel format: PJSIP/101-0000001a or SIP/101-0000001a
  const match = channel.match(/\/(\d+)[-/]/);
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

  // Create a tentative call_history record immediately
  const dbId = randomUUID();
  const userId = ext ? findUserByExtension(ext) : null;

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

  const call = activeCalls.get(uniqueId);
  if (call?.dbRecordId) {
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
  }
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

/** Query PJSIP endpoint status via AMI for extensions not covered by hints. */
async function queryPjsipEndpointState(
  client: AmiClient,
  extensionId: string,
): Promise<string | null> {
  try {
    const result = await client.sendAction({
      Action: "PJSIPShowEndpoint",
      Endpoint: extensionId,
    });
    // DeviceState is a direct key in the parsed AMI response
    if (result.DeviceState) {
      return mapAmiExtensionStatus(result.DeviceState);
    }
    return null;
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
