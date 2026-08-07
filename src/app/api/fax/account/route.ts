import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-helpers";
import db from "@/lib/db";
import { createFaxUser } from "@/lib/avantfax";
import { randomUUID } from "node:crypto";
import type { FaxAccount } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST() {
  const { user, error } = await requireUser();
  if (error) return error;

  // Check if account exists
  const existing = db
    .prepare("SELECT * FROM fax_accounts WHERE user_id = ?")
    .get(user.id) as FaxAccount | undefined;

  if (existing) {
    return NextResponse.json({ account: existing });
  }

  // Find a DID to use for fax
  const did = db
    .prepare("SELECT * FROM phone_numbers WHERE user_id = ? ORDER BY created_at ASC LIMIT 1")
    .get(user.id) as { did: string } | undefined;

  const faxUsername = `fax_${user.id.slice(0, 8)}`;

  // Provision AvantFax user
  try {
    await createFaxUser({
      username: faxUsername,
      email: user.email,
      did: did?.did ?? "",
    });
  } catch {
    // Non-critical — AvantFax may not be fully configured
  }

  const accountId = randomUUID();
  db.prepare(
    `INSERT INTO fax_accounts (id, user_id, avantfax_username, email, did, status)
     VALUES (?, ?, ?, ?, ?, 'active')`,
  ).run(accountId, user.id, faxUsername, user.email, did?.did ?? null);

  // Enable fax on the DID
  if (did) {
    db.prepare(
      "UPDATE phone_numbers SET fax_enabled = 1 WHERE did = ? AND user_id = ?",
    ).run(did.did, user.id);
  }

  const account = db
    .prepare("SELECT * FROM fax_accounts WHERE id = ?")
    .get(accountId) as FaxAccount;

  return NextResponse.json({ account }, { status: 201 });
}
