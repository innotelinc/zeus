import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-helpers";
import db from "@/lib/db";
import { getAmiClient } from "@/lib/ami";
import { queryExtensionState } from "@/lib/ami-handler";
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

  // Live AMI state refresh for extensions showing "unknown" or stale state.
  // Runs in parallel so multiple extensions don't add sequential latency.
  const ami = getAmiClient();
  if (ami.isConnected) {
    await Promise.allSettled(
      extensions
        .filter((ext) => ext.device_state === "unknown")
        .map(async (ext) => {
          const state = await queryExtensionState(ami, ext.extension_id);
          if (state && state !== "unknown") {
            ext.device_state = state;
          }
        }),
    );
  }

  return NextResponse.json({ numbers, extensions });
}
