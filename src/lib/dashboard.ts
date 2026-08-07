import db from "./db";
import type {
  UserDashboard,
  User,
  PhoneNumber,
  FreePBXExtension,
  SmsConversation,
  FaxAccount,
  Fax,
  Voicemail,
  CallHistoryEntry,
  BillingInvoice,
} from "./types";

export function getUserDashboard(userId: string): UserDashboard {
  const user = db
    .prepare(
      "SELECT id, email, name, phone, plan, plan_status, country, created_at, updated_at FROM users WHERE id = ?",
    )
    .get(userId) as User;

  const phone_numbers = db
    .prepare(
      "SELECT * FROM phone_numbers WHERE user_id = ? ORDER BY created_at DESC",
    )
    .all(userId) as PhoneNumber[];

  const extensions = db
    .prepare(
      "SELECT * FROM freepbx_extensions WHERE user_id = ? ORDER BY created_at DESC",
    )
    .all(userId) as FreePBXExtension[];

  const conversations = db
    .prepare(
      "SELECT * FROM sms_conversations WHERE user_id = ? ORDER BY updated_at DESC",
    )
    .all(userId) as SmsConversation[];

  const fax_account = db
    .prepare("SELECT * FROM fax_accounts WHERE user_id = ?")
    .get(userId) as FaxAccount | undefined;

  const faxes = db
    .prepare(
      "SELECT * FROM faxes WHERE user_id = ? ORDER BY created_at DESC LIMIT 20",
    )
    .all(userId) as Fax[];

  const voicemails = db
    .prepare(
      "SELECT * FROM voicemails WHERE user_id = ? ORDER BY created_at DESC LIMIT 20",
    )
    .all(userId) as Voicemail[];

  const recent_calls = db
    .prepare(
      "SELECT * FROM call_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 20",
    )
    .all(userId) as CallHistoryEntry[];

  const invoices = db
    .prepare(
      "SELECT * FROM billing_invoices WHERE user_id = ? ORDER BY created_at DESC LIMIT 12",
    )
    .all(userId) as BillingInvoice[];

  return {
    user,
    phone_numbers,
    extensions,
    conversations,
    fax_account: fax_account ?? null,
    faxes,
    voicemails,
    recent_calls,
    invoices,
  };
}
