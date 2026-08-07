import { NextResponse } from "next/server";
import { requireUser, badRequest } from "@/lib/api-helpers";
import db from "@/lib/db";
import * as freepbx from "@/lib/freepbx";
import { randomUUID } from "node:crypto";
import type { FreePBXExtension } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const { user, error } = await requireUser();
  if (error) return error;

  const extensions = db
    .prepare("SELECT * FROM freepbx_extensions WHERE user_id = ? ORDER BY created_at DESC")
    .all(user.id) as FreePBXExtension[];

  return NextResponse.json({ extensions });
}

export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;

  const body = await req.json().catch(() => ({}));

  if (!body.extensionId || !body.name || !body.email) {
    return badRequest("extensionId, name, and email are required");
  }

  try {
    const secret = body.secret ?? randomUUID().replace(/-/g, "").slice(0, 16);
    const vmPin = body.vmPassword ?? Math.random().toString().slice(2, 6);

    const result = await freepbx.addExtension({
      extensionId: body.extensionId,
      name: body.name,
      email: body.email,
      tech: "pjsip",
      secret,
      vmEnable: body.vmEnable ?? true,
      vmPassword: vmPin,
    });

    if (!result.addExtension.status) {
      return NextResponse.json(
        { error: result.addExtension.message },
        { status: 500 },
      );
    }

    const extId = randomUUID();
    db.prepare(
      `INSERT INTO freepbx_extensions (id, user_id, extension_id, extension_name, extension_secret, voicemail_enabled, voicemail_pin, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
    ).run(extId, user.id, body.extensionId, body.name, secret, body.vmEnable ? 1 : 0, vmPin);

    return NextResponse.json(
      { success: true, extensionId: body.extensionId, secret, message: result.addExtension.message },
      { status: 201 },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "FreePBX provisioning failed" },
      { status: 502 },
    );
  }
}
