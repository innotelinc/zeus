import { NextResponse } from "next/server";
import { requireUser, badRequest } from "@/lib/api-helpers";
import db from "@/lib/db";
import * as freepbx from "@/lib/freepbx";
import { getAmiClient } from "@/lib/ami";
import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import type { FreePBXExtension } from "@/lib/types";

export const dynamic = "force-dynamic";

const PJSIP_CONF_DIR = "/etc/asterisk";

function writeWssEndpoint(ext: string, secret: string): void {
  const conf = `[$ext](webrtc-template)\nauth = ${ext}-auth\naors = ${ext}-aor\n\n[${ext}-auth]\ntype = auth\nauth_type = userpass\npassword = ${secret}\nusername = ${ext}\n\n[${ext}-aor]\ntype = aor\nmax_contacts = 5\n`;
  const path = `${PJSIP_CONF_DIR}/pjsip_ext_${ext}.conf`;
  writeFileSync(path, conf, "utf8");

  // Ensure included in pjsip.conf
  const pjsipConf = `${PJSIP_CONF_DIR}/pjsip.conf`;
  if (existsSync(pjsipConf)) {
    const content = require("fs").readFileSync(pjsipConf, "utf8");
    if (!content.includes(`pjsip_ext_${ext}.conf`)) {
      require("fs").appendFileSync(pjsipConf, `\n#include pjsip_ext_${ext}.conf\n`);
    }
  }
}

function removeWssEndpoint(ext: string): void {
  const path = `${PJSIP_CONF_DIR}/pjsip_ext_${ext}.conf`;
  try { unlinkSync(path); } catch { /* not found */ }
}

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
      vmEnable: body.vmEnable ?? true,
      vmPassword: vmPin,
    });

    if (!result.addExtension.status) {
      return NextResponse.json(
        { error: result.addExtension.message },
        { status: 500 },
      );
    }

    // ── Create WSS WebRTC endpoint config ──────────────────
    try {
      writeWssEndpoint(body.extensionId, secret);
      // Reload PJSIP in Asterisk to pick up the new endpoint
      const ami = getAmiClient();
      if (ami.isConnected) {
        await ami.sendAction({ Action: "Command", Command: "module reload res_pjsip.so" }).catch(() => {});
      }
    } catch {
      // Non-critical — WSS config is best-effort; FreePBX already created
      // the standard PJSIP endpoint via GQL
    }

    const extId = randomUUID();
    db.prepare(
      `INSERT INTO freepbx_extensions (id, user_id, extension_id, extension_name, extension_secret, voicemail_enabled, voicemail_pin, status, device_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'offline')`,
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

export async function DELETE(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;

  const { searchParams } = new URL(req.url);
  const extId = searchParams.get("id");
  if (!extId) return badRequest("id query parameter is required");

  // Verify ownership
  const ext = db
    .prepare("SELECT * FROM freepbx_extensions WHERE id = ? AND user_id = ?")
    .get(extId, user.id) as FreePBXExtension | undefined;

  if (!ext) {
    return NextResponse.json({ error: "Extension not found" }, { status: 404 });
  }

  try {
    // Delete from FreePBX
    await freepbx.deleteExtension(ext.extension_id).catch(() => {
      // Non-critical — FreePBX may already have removed it
    });
  } catch {
    // Continue with local cleanup even if FreePBX fails
  }

  // Remove WSS endpoint config
  removeWssEndpoint(ext.extension_id);

  // Reload PJSIP
  const ami = getAmiClient();
  if (ami.isConnected) {
    await ami.sendAction({ Action: "Command", Command: "module reload res_pjsip.so" }).catch(() => {});
  }

  // Delete from local DB
  db.prepare("DELETE FROM freepbx_extensions WHERE id = ? AND user_id = ?").run(extId, user.id);

  return NextResponse.json({ success: true });
}
