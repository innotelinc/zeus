import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-helpers";
import { getConversations } from "@/lib/sms";

export const dynamic = "force-dynamic";

export async function GET() {
  const { user, error } = await requireUser();
  if (error) return error;

  const conversations = getConversations(user.id);
  return NextResponse.json({ conversations });
}
