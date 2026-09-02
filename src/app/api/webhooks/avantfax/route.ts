import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import db from "@/lib/db";
import { buildFaxReceivedEmail } from "@/lib/mail-templates";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/avantfax
 *
 * Called by AvantFax's faxrcvd.php when a new inbound fax is received.
 *
 * AvantFax passes the fax details via command-line args to faxrcvd.php;
 * configure it to POST here:
 *
 *   // In /var/www/html/fax/includes/faxrcvd.php, add:
 *   $payload = json_encode([
 *     'fax_id'     => $fax_id,
 *     'from_number'=> $caller_id,
 *     'to_number'  => $did_number,
 *     'pages'      => $num_pages,
 *     'file_path'  => $file_path,
 *     'subject'    => $subject ?? '',
 *   ]);
 *   file_get_contents('https://app.zeus.innotel.us/api/webhooks/avantfax', false,
 *     stream_context_create([
 *       'http' => [
 *         'method'  => 'POST',
 *         'header'  => "Content-Type: application/json\r\n" .
 *                      "X-Webhook-Secret: " . $WEBHOOK_SECRET,
 *         'content' => $payload,
 *       ],
 *     ])
 *   );
 *
 * Also accepts form-encoded callbacks for older AvantFax setups.
 */

export async function POST(req: Request) {
  // Optional webhook secret
  const webhookSecret = process.env.AVANTFAX_WEBHOOK_SECRET;
  if (webhookSecret) {
    const provided = req.headers.get("x-webhook-secret");
    if (provided !== webhookSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  // Parse body — support JSON and form-encoded
  let body: Record<string, unknown>;
  const contentType = req.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const text = await req.text();
      body = Object.fromEntries(new URLSearchParams(text));
    } else {
      body = (await req.json()) as Record<string, unknown>;
    }
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  // Extract fields — AvantFax uses various key names
  const fromNumber = String(body.from_number ?? body.cid_number ?? body.caller_id ?? "");
  const toNumber = String(body.to_number ?? body.did_number ?? body.destination ?? "");
  const pages = parseInt(String(body.pages ?? 1), 10) || 1;
  const filePath = String(body.file_path ?? body.file ?? "");
  const subject = String(body.subject ?? "");

  if (!toNumber) {
    return NextResponse.json(
      { error: "missing_to_number", detail: "Cannot route fax without a destination DID" },
      { status: 400 },
    );
  }

  // Find the user who owns this DID
  const phone = db
    .prepare(
      "SELECT p.user_id, p.did, u.email, u.name FROM phone_numbers p JOIN users u ON u.id = p.user_id WHERE p.did = ? AND p.fax_enabled = 1",
    )
    .get(toNumber) as { user_id: string; did: string; email: string; name: string } | undefined;

  if (!phone) {
    console.warn(
      `[AvantFax Webhook] Inbound fax to ${toNumber} — no matching user with fax enabled`,
    );
    return NextResponse.json(
      { error: "unregistered_did", detail: `No fax-enabled user found for DID ${toNumber}` },
      { status: 404 },
    );
  }

  // Idempotency: check for duplicate fax within last 2 minutes
  const recentCutoff = new Date(Date.now() - 120_000).toISOString();
  const existing = db
    .prepare(
      "SELECT id FROM faxes WHERE user_id = ? AND direction = 'inbound' AND from_number = ? AND to_number = ? AND created_at > ? LIMIT 1",
    )
    .get(phone.user_id, fromNumber || "Unknown", toNumber, recentCutoff) as { id: string } | undefined;

  if (existing) {
    console.log(
      `[AvantFax Webhook] Duplicate fax detected (${existing.id}), ignoring retry`,
    );
    return NextResponse.json(
      { status: "duplicate", fax_id: existing.id },
    );
  }

  // Link to fax account if one exists
  const faxAccount = db
    .prepare("SELECT id FROM fax_accounts WHERE user_id = ? LIMIT 1")
    .get(phone.user_id) as { id: string } | undefined;

  // Create the inbound fax record
  const faxId = randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO faxes (id, user_id, fax_account_id, direction, status, from_number, to_number, pages, file_path, file_type, subject, created_at, completed_at)
     VALUES (?, ?, ?, 'inbound', 'received', ?, ?, ?, ?, 'pdf', ?, ?, ?)`,
  ).run(
    faxId,
    phone.user_id,
    faxAccount?.id ?? null,
    fromNumber || "Unknown",
    toNumber,
    pages,
    filePath || null,
    subject || null,
    now,
    now,
  );

  // Send email notification (async, non-blocking)
  buildFaxReceivedEmail({
    email: phone.email,
    fromNumber: fromNumber || "Unknown",
    toNumber,
    pages,
    subject: subject || null,
    receivedAt: now,
  }).catch((err) => {
    console.error("[AvantFax Webhook] Failed to send fax notification:", err);
  });

  console.log(
    `[AvantFax Webhook] Inbound fax from ${fromNumber} → ${toNumber} (${pages} page(s)) for ${phone.name} (${phone.email})`,
  );

  return NextResponse.json(
    { status: "received", fax_id: faxId, user: phone.name },
    { status: 201 },
  );
}

/** GET — simple health check */
export async function GET() {
  return NextResponse.json({
    status: "ok",
    ready: true,
    note: "POST here from AvantFax faxrcvd.php to register inbound faxes",
  });
}
