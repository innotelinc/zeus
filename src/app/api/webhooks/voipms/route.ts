import { NextResponse } from "next/server";
import db from "@/lib/db";
import { receiveMessage } from "@/lib/sms";
import type { PhoneNumber } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * VoIP.ms SMS webhook endpoint.
 *
 * Configure this URL in your VoIP.ms portal under
 * DID Settings → SMS → SMS URL Callback.
 *
 * VoIP.ms POSTs SMS with: did, dst, from, message, date, id
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => {
      // VoIP.ms may send form-encoded
      return {};
    });

    const did = body.did;
    const from = body.from;
    const message = body.message;
    const smsId = body.id;

    if (!did || !from || !message) {
      return NextResponse.json(
        { error: "Missing required fields (did, from, message)" },
        { status: 400 },
      );
    }

    // Find the user who owns this DID
    const number = db
      .prepare("SELECT * FROM phone_numbers WHERE did = ? AND status = 'active'")
      .get(did) as PhoneNumber | undefined;

    if (!number) {
      return NextResponse.json({ error: "DID not found" }, { status: 404 });
    }

    // Record inbound message
    await receiveMessage({
      user_id: number.user_id,
      from_number: from,
      to_did: did,
      body: message,
      voipms_sms_id: smsId,
    });

    return NextResponse.json({ status: "received" });
  } catch (e) {
    console.error("VoIP.ms webhook error:", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
