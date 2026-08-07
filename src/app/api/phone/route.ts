import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-helpers";
import db from "@/lib/db";
import type { PhoneNumber, FreePBXExtension } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const { user, error } = await requireUser();
  if (error) return error;

  const numbers = db
    .prepare("SELECT * FROM phone_numbers WHERE user_id = ? ORDER BY created_at DESC")
    .all(user.id) as PhoneNumber[];

  const extensions = db
    .prepare("SELECT * FROM freepbx_extensions WHERE user_id = ? ORDER BY created_at DESC")
    .all(user.id) as FreePBXExtension[];

  return NextResponse.json({ numbers, extensions });
}
