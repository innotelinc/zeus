/**
 * SMS message handling module.
 *
 * Uses VoIP.ms API for sending/receiving SMS messages.
 * Maintains local conversation/message store for the full messaging UI.
 */

import { randomUUID } from "node:crypto";
import db from "./db";
import * as voipms from "./voipms";
import type { SmsConversation, SmsMessage } from "./types";

/** Send an SMS message and record it. */
export async function sendMessage(params: {
  user_id: string;
  did: string;
  to_number: string;
  body: string;
}): Promise<SmsMessage> {
  // Send via VoIP.ms
  await voipms.sendSMS({
    did: params.did,
    dst: params.to_number,
    message: params.body,
  });

  // Find or create conversation
  const conv = await getOrCreateConversation(
    params.user_id,
    params.to_number,
    params.did,
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

  return db
    .prepare("SELECT * FROM sms_messages WHERE id = ?")
    .get(msgId) as SmsMessage;
}

/** Record an inbound SMS message (from webhook or poll). */
export async function receiveMessage(params: {
  user_id: string;
  from_number: string;
  to_did: string;
  body: string;
  voipms_sms_id?: string;
}): Promise<SmsMessage> {
  const conv = await getOrCreateConversation(
    params.user_id,
    params.from_number,
    params.to_did,
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

/** Get or create a conversation for a contact. */
async function getOrCreateConversation(
  userId: string,
  contactPhone: string,
  phoneNumberId: string,
): Promise<SmsConversation> {
  const conv = db
    .prepare(
      `SELECT c.* FROM sms_conversations c
       WHERE c.user_id = ? AND c.contact_phone = ?
       ORDER BY c.updated_at DESC
       LIMIT 1`,
    )
    .get(userId, contactPhone) as SmsConversation | undefined;

  if (conv) return conv;

  // Look up contact name
  const contact = db
    .prepare(
      "SELECT name FROM contacts WHERE user_id = ? AND phone = ?",
    )
    .get(userId, contactPhone) as { name: string } | undefined;

  const convId = randomUUID();
  db.prepare(
    `INSERT INTO sms_conversations (id, user_id, phone_number_id, contact_phone, contact_name)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(convId, userId, phoneNumberId, contactPhone, contact?.name ?? null);

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
