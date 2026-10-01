import { NextResponse } from "next/server";
import { requireUserOrService, badRequest } from "@/lib/api-helpers";
import { SCOPE } from "@/lib/service-auth";
import db from "@/lib/db";
import * as voipms from "@/lib/voipms";
import { randomUUID } from "node:crypto";
import type { PhoneNumber } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function DELETE(req: Request) {
  // Releasing a number is a write, so it asks for the ordering scope: a token
  // that may only read numbers cannot hand one back.
  const { user, error } = await requireUserOrService(req, SCOPE.numbersOrder);
  if (error) return error;

  const { searchParams } = new URL(req.url);
  const did = searchParams.get("did");
  if (!did) return badRequest("did query parameter is required");

  // Verify ownership
  const owned = db
    .prepare("SELECT id FROM phone_numbers WHERE user_id = ? AND did = ?")
    .get(user.id, did);
  if (!owned) {
    return NextResponse.json({ error: "Number not found" }, { status: 404 });
  }

  // Release from VoIP.ms
  try {
    await voipms.cancelDID(did);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "VoIP.ms release failed" },
      { status: 502 },
    );
  }

  // Delete from local DB
  db.prepare("DELETE FROM phone_numbers WHERE user_id = ? AND did = ?").run(user.id, did);

  return NextResponse.json({ success: true });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));

  // The action decides the scope, so the body is read first: searching is a
  // read (`numbers:read`), ordering spends money on a DID (`numbers:order`), and
  // an unrecognised action is treated as the write it might be rather than the
  // read it claims. A token scoped only to read cannot order a number by
  // changing the action string.
  const { user, error } = await requireUserOrService(
    req,
    body.action === "search" ? SCOPE.numbersRead : SCOPE.numbersOrder,
  );
  if (error) return error;

  // Search for available DIDs
  if (body.action === "search") {
    try {
      const result = await voipms.getDIDsInfo({
        areacode: body.areacode,
        province: body.province,
        ratecenter: body.ratecenter,
        quantity: body.quantity ?? 10,
      });
      return NextResponse.json(result);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "VoIP.ms API error" },
        { status: 502 },
      );
    }
  }

  // Order a specific DID
  if (body.action === "order") {
    if (!body.did) {
      return badRequest("did is required");
    }

    // Check plan limits
    const plan = user.plan;
    const maxDids = plan === "business" ? 5 : 1;
    const currentCount = (
      db.prepare("SELECT COUNT(*) as c FROM phone_numbers WHERE user_id = ?").get(user.id) as { c: number }
    ).c;

    if (currentCount >= maxDids) {
      return NextResponse.json(
        { error: `Your ${plan} plan allows up to ${maxDids} number(s). Upgrade to add more.` },
        { status: 403 },
      );
    }

    try {
      await voipms.orderDID(body.did);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "VoIP.ms order failed" },
        { status: 502 },
      );
    }

    // Enable SMS on the DID
    try {
      await voipms.enableSMS(body.did);
    } catch {
      // Non-critical — SMS may already be enabled
    }

    const numId = randomUUID();
    db.prepare(
      `INSERT INTO phone_numbers (id, user_id, did, area_code, server, sms_enabled, fax_enabled, status)
       VALUES (?, ?, ?, ?, ?, 1, 0, 'active')`,
    ).run(numId, user.id, body.did, body.areacode ?? null, body.server ?? null);

    const number = db
      .prepare("SELECT * FROM phone_numbers WHERE id = ?")
      .get(numId) as PhoneNumber;

    return NextResponse.json({ number }, { status: 201 });
  }

  return badRequest("action must be 'search' or 'order'");
}
