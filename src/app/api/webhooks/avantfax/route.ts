import { NextResponse } from "next/server";
import db from "@/lib/db";
import { buildFaxReceivedEmail } from "@/lib/mail-templates";

/**
 * POST /api/webhooks/avantfax
 *
 * Called by AvantFax's faxrcvd.php when a new fax is received.
 * Expects JSON: { fax_id, from_number, to_number, pages, subject? }
 *
 * Also supports AvantFax's native form-encoded callback.
 */
export async function POST(req: Request) {
  let body: Record<string, unknown>;

  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    body = Object.fromEntries(new URLSearchParams(text));
  } else {
    body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  }

  const faxId = typeof body.fax_id === "string" ? body.fax_id : String(body.fax_id ?? "");
  const fromNumber = typeof body.from_number === "string" ? body.from_number : String(body.from_number ?? "Unknown");
  const toNumber = typeof body.to_number === "string" ? body.to_number : String(body.to_number ?? "");
  const pages = Number(body.pages ?? 1);

  if (!faxId) {
    return NextResponse.json(
      { error: "Missing fax_id" },
      { status: 400 },
    );
  }

  // Look up the fax to get the user and full details
  const fax = db
    .prepare("SELECT * FROM faxes WHERE id = ?")
    .get(faxId) as Record<string, unknown> | undefined;

  if (!fax) {
    return NextResponse.json(
      { error: "Fax not found" },
      { status: 404 },
    );
  }

  const userId = String(fax.user_id ?? "");

  // Get user email
  const user = db
    .prepare("SELECT email, name FROM users WHERE id = ?")
    .get(userId) as { email: string; name: string } | undefined;

  if (!user) {
    return NextResponse.json(
      { error: "User not found" },
      { status: 404 },
    );
  }

  // Send the notification
  buildFaxReceivedEmail({
    email: user.email,
    fromNumber,
    toNumber,
    pages,
    subject: typeof body.subject === "string" ? body.subject : null,
    receivedAt: String(fax.created_at ?? new Date().toISOString()),
  }).catch((err) => {
    console.error("[AvantFax Webhook] Failed to send fax notification:", err);
  });

  return NextResponse.json({ status: "received" });
}
