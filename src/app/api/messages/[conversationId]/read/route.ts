import { NextResponse } from "next/server";
import { requireUser, notFound } from "@/lib/api-helpers";
import { markConversationRead } from "@/lib/sms";
import db from "@/lib/db";
import type { SmsConversation } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const { user, error } = await requireUser();
  if (error) return error;

  const { conversationId } = await params;
  const conv = db
    .prepare("SELECT * FROM sms_conversations WHERE id = ? AND user_id = ?")
    .get(conversationId, user.id) as SmsConversation | undefined;

  if (!conv) return notFound("Conversation not found");

  markConversationRead(user.id, conversationId);
  return NextResponse.json({ success: true });
}
