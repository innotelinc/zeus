/**
 * SMS message handling module.
 *
 * Outbound SMS leaves through one of two transports, selected by
 * `SMS_PROVIDER`:
 *   freepbx (default) — the FreePBX/Asterisk PJSIP trunk (AMI `MessageSend`,
 *                       mirroring the sms-out dialplan)
 *   opensms           — a local OpenSMS Android gateway (POST /sms/)
 *   auto              — OpenSMS when configured, falling back to the trunk
 *
 * Inbound SMS is unaffected: it arrives via the VoIP.ms SMS URL callback
 * webhook (the sms-in side of the trunk forwards to internal extensions).
 * Maintains the local conversation/message store for the full messaging UI.
 */

import { randomUUID } from "node:crypto";
import db from "./db";
import { getAmiClient } from "./ami";
import { isOpenSmsConfigured, sendOpenSms } from "./opensms";
import type { SmsConversation, SmsMessage } from "./types";

export type SmsProvider = "freepbx" | "opensms" | "auto";
export type SmsTransport = "freepbx" | "opensms";

/**
 * The operator-facing transport choice, as the Messages composer sends it.
 * `provider` is the VoIP.ms trunk, `local` the OpenSMS Android gateway.
 */
export type SmsTransportChoice = "provider" | "local" | "auto";

/** The configured outbound transport (`SMS_PROVIDER`, default `freepbx`). */
export function smsProvider(): SmsProvider {
  const raw = (process.env.SMS_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "freepbx" || raw === "opensms" || raw === "auto") return raw;
  if (raw) {
    console.warn(
      `[SMS] Unknown SMS_PROVIDER "${raw}" — using the FreePBX trunk`,
    );
  }
  return "freepbx";
}

/** Map the composer's choice onto a transport; unset = `SMS_PROVIDER`. */
export function resolveProvider(choice?: SmsTransportChoice): SmsProvider {
  if (choice === "provider") return "freepbx";
  if (choice === "local") return "opensms";
  if (choice === "auto") return "auto";
  return smsProvider();
}

/**
 * Send one message over the selected transport and report which one carried it.
 *
 * `auto` exists for the phone-off-the-charger case: an OpenSMS gateway is a
 * single Android device on the LAN, while the trunk is the carrier path, so a
 * failed gateway keeps the message moving instead of failing the send.
 */
async function sendOutbound(
  params: {
    did: string;
    to_number: string;
    body: string;
  },
  choice?: SmsTransportChoice,
): Promise<SmsTransport> {
  const provider = resolveProvider(choice);

  if (provider !== "freepbx") {
    if (!isOpenSmsConfigured()) {
      if (provider === "opensms") {
        throw new Error(
          "SMS_PROVIDER=opensms but OPENSMS_URL / OPENSMS_API_KEY are not set",
        );
      }
    } else {
      try {
        await sendOpenSms({ to: params.to_number, body: params.body });
        return "opensms";
      } catch (e) {
        if (provider === "opensms") throw e;
        const reason = e instanceof Error ? e.message : String(e);
        console.warn(
          `[SMS] OpenSMS send failed — falling back to the FreePBX trunk: ${reason}`,
        );
      }
    }
  }

  await sendViaFreepbxTrunk(params);
  return "freepbx";
}

/**
 * SMS is sent over the FreePBX/Asterisk PJSIP trunk (SIP MESSAGE via the
 * AMI `MessageSend` action) — the same path setup.sh wires as the `sms-out`
 * dialplan context — instead of the VoIP.ms REST API (per-message fee).
 *
 * Trunk env (see setup.sh): VOIPMS_TRUNK_NAME (default voipms_pjsip),
 * VOIPMS_SIP_SERVER, VOIPMS_SIP_USER. `SMS_TRUNK_FROM_USER` overrides the
 * From URI user part (defaults to the trunk sub-account, matching sms-out).
 */
async function sendViaFreepbxTrunk(params: {
  did: string;
  to_number: string;
  body: string;
}): Promise<void> {
  const trunk = process.env.VOIPMS_TRUNK_NAME ?? "voipms_pjsip";
  const server = process.env.VOIPMS_SIP_SERVER ?? "newyork1.voip.ms";
  const fromUser =
    process.env.SMS_TRUNK_FROM_USER ?? process.env.VOIPMS_SIP_USER ?? "";

  if (!fromUser) {
    throw new Error(
      "VOIPMS_SIP_USER not set — cannot send SMS over the FreePBX trunk",
    );
  }

  const client = getAmiClient();
  if (!client.isConnected) {
    throw new Error(
      "AMI not connected — FreePBX SMS transport unavailable (start Asterisk/AMI)",
    );
  }

  // Mirror the sms-out dialplan context from scripts/setup.sh:
  //   ACTUAL_TO   = pjsip:<trunk>/sip:<number>@<server>
  //   ACTUAL_FROM = <display: the DID> <sip:<from-user>@<server>>
  await client.sendAction({
    Action: "MessageSend",
    To: `pjsip:${trunk}/sip:${params.to_number}@${server}`,
    From: `${params.did} <sip:${fromUser}@${server}>`,
    Body: params.body,
  });
}

/** Send an SMS message and record it. */
export async function sendMessage(params: {
  user_id: string;
  did: string;
  to_number: string;
  body: string;
  /** Per-send override; unset = `SMS_PROVIDER`. */
  transport?: SmsTransportChoice;
}): Promise<{ message: SmsMessage; transport: SmsTransport }> {
  // Send over the selected transport (FreePBX trunk by default — no VoIP.ms
  // REST per-message fee). Inbound replies still come back through the webhook.
  const transport = await sendOutbound(
    {
      did: params.did,
      to_number: params.to_number,
      body: params.body,
    },
    params.transport,
  );
  console.log(
    `[SMS] sent to ${params.to_number} via ${transport} (from ${params.did})`,
  );

  // Find or create conversation. sms_conversations.phone_number_id is an FK to
  // phone_numbers(id), so resolve the row for this DID rather than storing the
  // raw DID number (which violates the FK).
  const phoneNumber = db
    .prepare("SELECT id FROM phone_numbers WHERE user_id = ? AND did = ?")
    .get(params.user_id, params.did) as { id: string } | undefined;
  const conv = await getOrCreateConversation(
    params.user_id,
    params.to_number,
    phoneNumber?.id ?? null,
  );

  // Store outbound message
  const msgId = randomUUID();
  db.prepare(
    `INSERT INTO sms_messages (id, conversation_id, user_id, direction, from_number, to_number, body, status, segments)
     VALUES (?, ?, ?, 'outbound', ?, ?, ?, 'sent', ?)`,
  ).run(
    msgId,
    conv.id,
    params.user_id,
    params.did,
    params.to_number,
    params.body,
    Math.ceil(params.body.length / 160),
  );

  // Update conversation
  db.prepare(
    `UPDATE sms_conversations
     SET last_message_text = ?, last_message_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`,
  ).run(params.body, conv.id);

  const message = db
    .prepare("SELECT * FROM sms_messages WHERE id = ?")
    .get(msgId) as SmsMessage;
  return { message, transport };
}

/** Record an inbound SMS message (from webhook or poll). */
export async function receiveMessage(params: {
  user_id: string;
  from_number: string;
  to_did: string;
  body: string;
  voipms_sms_id?: string;
}): Promise<SmsMessage> {
  // Same FK resolution as sendMessage: map the inbound DID to its row id.
  const phoneNumber = db
    .prepare("SELECT id FROM phone_numbers WHERE user_id = ? AND did = ?")
    .get(params.user_id, params.to_did) as { id: string } | undefined;
  const conv = await getOrCreateConversation(
    params.user_id,
    params.from_number,
    phoneNumber?.id ?? null,
  );

  const msgId = randomUUID();
  db.prepare(
    `INSERT INTO sms_messages (id, conversation_id, user_id, direction, from_number, to_number, body, status, segments)
     VALUES (?, ?, ?, 'inbound', ?, ?, ?, 'delivered', ?)`,
  ).run(
    msgId,
    conv.id,
    params.user_id,
    params.from_number,
    params.to_did,
    params.body,
    Math.ceil(params.body.length / 160),
  );

  db.prepare(
    `UPDATE sms_conversations
     SET last_message_text = ?, last_message_at = datetime('now'),
         unread_count = unread_count + 1, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(params.body, conv.id);

  return db
    .prepare("SELECT * FROM sms_messages WHERE id = ?")
    .get(msgId) as SmsMessage;
}

/** Normalize a phone number to digits so inbound (+1…) and outbound threads merge. */
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 5 ? digits : phone;
}

/** Get or create a conversation for a contact. */
async function getOrCreateConversation(
  userId: string,
  contactPhone: string,
  phoneNumberId: string | null,
): Promise<SmsConversation> {
  // Key conversations on the digits-only number: outbound stores “14134210134”,
  // the inbound webhook reports “+14134210134” — they must share one thread.
  const normalized = normalizePhone(contactPhone);
  const conv = db
    .prepare(
      `SELECT c.* FROM sms_conversations c
       WHERE c.user_id = ? AND c.contact_phone = ?
       ORDER BY c.updated_at DESC
       LIMIT 1`,
    )
    .get(userId, normalized) as SmsConversation | undefined;

  if (conv) return conv;

  // Look up contact name
  const contact = db
    .prepare(
      "SELECT name FROM contacts WHERE user_id = ? AND phone = ?",
    )
    .get(userId, normalized) as { name: string } | undefined;

  const convId = randomUUID();
  db.prepare(
    `INSERT INTO sms_conversations (id, user_id, phone_number_id, contact_phone, contact_name)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(convId, userId, phoneNumberId, normalized, contact?.name ?? null);

  return db
    .prepare("SELECT * FROM sms_conversations WHERE id = ?")
    .get(convId) as SmsConversation;
}

/** Get all conversations for a user. */
export function getConversations(userId: string): SmsConversation[] {
  return db
    .prepare(
      `SELECT * FROM sms_conversations
       WHERE user_id = ?
       ORDER BY updated_at DESC`,
    )
    .all(userId) as SmsConversation[];
}

/** Get messages for a conversation. */
export function getMessages(
  userId: string,
  conversationId: string,
  limit = 50,
  offset = 0,
): SmsMessage[] {
  return db
    .prepare(
      `SELECT * FROM sms_messages
       WHERE conversation_id = ? AND user_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(conversationId, userId, limit, offset) as SmsMessage[];
}

/** Mark a conversation as read. */
export function markConversationRead(
  userId: string,
  conversationId: string,
): void {
  db.prepare(
    "UPDATE sms_conversations SET unread_count = 0 WHERE id = ? AND user_id = ?",
  ).run(conversationId, userId);
}
