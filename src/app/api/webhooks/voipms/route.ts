import { NextResponse, type NextRequest } from "next/server";
import db from "@/lib/db";
import { receiveMessage } from "@/lib/sms";
import type { PhoneNumber } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * VoIP.ms SMS webhook endpoint.
 *
 * Configure this URL in your VoIP.ms portal under
 * DID Settings → SMS → SMS URL Callback:
 *   https://pbx.innotel.us/api/webhooks/voipms
 *
 * VoIP.ms POSTs SMS data as application/x-www-form-urlencoded:
 *   did, dst, from, message, date, id
 */

// Shared secret for webhook validation (set in .env)
function getWebhookSecret(): string | null {
  return process.env.VOIPMS_WEBHOOK_SECRET || null;
}

/**
 * Parse the request body regardless of content type.
 * VoIP.ms sends form-encoded data, but we also accept JSON.
 */
async function parseBody(req: NextRequest): Promise<Record<string, string>> {
  const contentType = req.headers.get("content-type") || "";

  // Try form-encoded first (VoIP.ms default)
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    const params = new URLSearchParams(text);
    const body: Record<string, string> = {};
    for (const [key, value] of params) {
      body[key] = value;
    }
    return body;
  }

  // Try form-encoded with different content type (some VoIP.ms configs)
  const text = await req.text();
  if (text.includes("did=") && text.includes("message=")) {
    const params = new URLSearchParams(text);
    const body: Record<string, string> = {};
    for (const [key, value] of params) {
      body[key] = value;
    }
    return body;
  }

  // Try JSON as fallback
  try {
    return JSON.parse(text) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * GET — VoIP.ms URL verification.
 * Some VoIP.ms configurations send a GET request first to verify
 * the webhook URL is alive before sending POST messages.
 */
export async function GET(req: NextRequest) {
  // Optional: verify challenge token
  const token = req.nextUrl.searchParams.get("token");
  if (token) {
    const secret = getWebhookSecret();
    if (secret && token === secret) {
      return NextResponse.json({ status: "verified", challenge: token });
    }
  }

  // Return 200 to confirm the webhook is alive
  return NextResponse.json({
    status: "ok",
    service: "Innotel PBX VoIP.ms SMS Webhook",
    endpoints: ["POST /api/webhooks/voipms"],
  });
}

/**
 * POST — Receive inbound SMS from VoIP.ms.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req);

    // Extract fields (VoIP.ms uses both 'message' and 'msg' field names)
    const did = body.did || body.to || "";
    const from = body.from || body.sender || "";
    const message = body.message || body.msg || body.text || "";
    const smsId = body.id || body.sms_id || "";

    console.log(
      `[SMS Webhook] From: ${from} → DID: ${did} | MsgID: ${smsId}`,
    );

    if (!did || !from || !message) {
      console.warn("[SMS Webhook] Missing required fields:", body);
      return NextResponse.json(
        { error: "Missing required fields (did, from, message)" },
        { status: 400 },
      );
    }

    // ── Find the user who owns this DID ────────────────────────
    const number = db
      .prepare("SELECT * FROM phone_numbers WHERE did = ? AND status = 'active'")
      .get(did) as PhoneNumber | undefined;

    if (!number) {
      // Try stripping leading digits (some VoIP.ms formats include country code)
      const stripped = did.replace(/^\+?1/, "");
      const altNumber = db
        .prepare("SELECT * FROM phone_numbers WHERE did = ? AND status = 'active'")
        .get(stripped) as PhoneNumber | undefined;

      if (!altNumber) {
        console.warn(`[SMS Webhook] DID not found: ${did}`);
        // Return 200 anyway so VoIP.ms doesn't retry
        return NextResponse.json({ status: "received", warning: "DID not registered" });
      }

      await recordInbound(altNumber, from, message, smsId);
      return NextResponse.json({ status: "received" });
    }

    // ── Record the inbound message ────────────────────────────
    await recordInbound(number, from, message, smsId);

    return NextResponse.json({ status: "received" });
  } catch (e) {
    console.error("[SMS Webhook] Error:", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

async function recordInbound(
  number: PhoneNumber,
  from: string,
  message: string,
  smsId: string,
) {
  try {
    await receiveMessage({
      user_id: number.user_id,
      from_number: from,
      to_did: number.did,
      body: message,
      voipms_sms_id: smsId,
    });
    console.log(`[SMS Webhook] Recorded: ${from} → ${number.did} [${smsId}]`);
  } catch (err) {
    console.error("[SMS Webhook] receiveMessage failed:", err);
  }
}
