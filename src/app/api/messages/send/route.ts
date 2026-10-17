import { NextResponse } from "next/server";
import { requireUser, badRequest } from "@/lib/api-helpers";
import { smsSchema } from "@/lib/validators";
import { sendMessage } from "@/lib/sms";
import db from "@/lib/db";
import type { SmsConversation } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;

  const body = await req.json().catch(() => ({}));
  const parsed = smsSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
  }

  const { to_number, from_did_id, body: msgBody, transport } = parsed.data;

  // Get the DID
  const did = db
    .prepare("SELECT * FROM phone_numbers WHERE id = ? AND user_id = ?")
    .get(from_did_id, user.id) as { did: string } | undefined;

  if (!did) {
    return badRequest("Invalid source phone number");
  }

  try {
    const { message, transport: used } = await sendMessage({
      user_id: user.id,
      did: did.did,
      to_number,
      body: msgBody,
      transport,
    });

    // Return the conversation too
    const conversation = db
      .prepare("SELECT * FROM sms_conversations WHERE id = ?")
      .get(message.conversation_id) as SmsConversation;

    return NextResponse.json(
      { message, conversation, transport: used },
      { status: 201 },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to send SMS" },
      { status: 502 },
    );
  }
}
