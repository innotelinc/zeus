export type Plan = "consumer" | "business";

export interface User {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  plan: Plan;
  plan_status: string;
  country: string;
  role: string | null;
  stripe_subscription_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PhoneNumber {
  id: string;
  user_id: string;
  did: string;
  area_code: string | null;
  location: string | null;
  server: string | null;
  sms_enabled: number;
  fax_enabled: number;
  status: string;
  created_at: string;
}

export interface FreePBXExtension {
  id: string;
  user_id: string;
  extension_id: string;
  extension_name: string | null;
  extension_secret: string | null;
  voicemail_enabled: number;
  voicemail_pin: string | null;
  status: string;
  device_state: string;
  created_at: string;
  updated_at: string;
}

export interface SmsConversation {
  id: string;
  user_id: string;
  phone_number_id: string | null;
  contact_phone: string;
  contact_name: string | null;
  last_message_text: string | null;
  last_message_at: string | null;
  unread_count: number;
  created_at: string;
  updated_at: string;
}

export interface SmsMessage {
  id: string;
  conversation_id: string;
  user_id: string;
  direction: "inbound" | "outbound";
  from_number: string;
  to_number: string;
  body: string;
  status: string;
  segments: number;
  created_at: string;
}

export interface Contact {
  id: string;
  user_id: string;
  name: string;
  phone: string;
  email: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface FaxAccount {
  id: string;
  user_id: string;
  avantfax_user_id: string | null;
  avantfax_username: string | null;
  email: string | null;
  did: string | null;
  status: string;
  created_at: string;
}

export interface Fax {
  id: string;
  user_id: string;
  fax_account_id: string | null;
  direction: "inbound" | "outbound";
  status: string;
  from_number: string | null;
  to_number: string;
  pages: number;
  file_path: string | null;
  file_type: string;
  subject: string | null;
  notes: string | null;
  created_at: string;
  completed_at: string | null;
  scheduled_at: string | null;
}

export interface Voicemail {
  id: string;
  user_id: string;
  extension_id: string | null;
  caller_id: string | null;
  caller_name: string | null;
  duration_seconds: number;
  transcript: string | null;
  listened: number;
  file_path: string | null;
  created_at: string;
}

export interface CallHistoryEntry {
  id: string;
  user_id: string;
  extension_id: string | null;
  direction: "inbound" | "outbound" | "internal";
  caller_number: string;
  callee_number: string;
  caller_name: string | null;
  duration_seconds: number;
  status: string;
  recording_path: string | null;
  created_at: string;
}

export interface BillingInvoice {
  id: string;
  user_id: string;
  invoice_number: string;
  period_start: string;
  period_end: string;
  amount_due: number;
  amount_paid: number;
  status: string;
  stripe_invoice_id: string | null;
  created_at: string;
  paid_at: string | null;
}

export interface UserDashboard {
  user: User;
  phone_numbers: PhoneNumber[];
  extensions: FreePBXExtension[];
  conversations: SmsConversation[];
  fax_account: FaxAccount | null;
  faxes: Fax[];
  voicemails: Voicemail[];
  recent_calls: CallHistoryEntry[];
  invoices: BillingInvoice[];
}
