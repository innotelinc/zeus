import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-helpers";
import { getAmiClient } from "@/lib/ami";
import db from "@/lib/db";
import { z } from "zod";

export const dynamic = "force-dynamic";

const originateSchema = z.object({
  extension_id: z.string().min(1, "Extension ID is required"),
  destination: z.string().min(1, "Destination number is required"),
  caller_id: z.string().optional(),
});

export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const parsed = originateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  const { extension_id, destination, caller_id } = parsed.data;

  // Verify the extension belongs to the authenticated user
  const ext = db
    .prepare(
      "SELECT extension_id FROM freepbx_extensions WHERE id = ? AND user_id = ?",
    )
    .get(extension_id, user.id) as { extension_id: string } | undefined;

  if (!ext) {
    return NextResponse.json(
      { error: "Extension not found or not owned by you" },
      { status: 404 },
    );
  }

  // Sanitize destination: strip everything except digits, +, *, #
  const cleanDest = destination.replace(/[^\d+*#]/g, "");
  if (!cleanDest) {
    return NextResponse.json(
      { error: "Invalid destination number" },
      { status: 400 },
    );
  }

  const client = getAmiClient();
  if (!client.isConnected) {
    return NextResponse.json(
      { error: "AMI not connected — cannot place outbound calls" },
      { status: 503 },
    );
  }

  try {
    await client.sendAction({
      Action: "Originate",
      Channel: `PJSIP/${ext.extension_id}`,
      Context: "from-internal",
      Exten: cleanDest,
      Priority: "1",
      CallerID: caller_id ?? cleanDest,
      Timeout: "30000",
      Async: "true",
    });

    console.log(
      `AMI Originate: ${ext.extension_id} → ${cleanDest} (user: ${user.id})`,
    );

    return NextResponse.json({
      success: true,
      message: `Calling ${cleanDest} — your extension will ring shortly.`,
      destination: cleanDest,
    });
  } catch (e) {
    console.error("AMI Originate failed:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to initiate call" },
      { status: 500 },
    );
  }
}
