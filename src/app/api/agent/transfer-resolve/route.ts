import { NextResponse } from "next/server";
import { badRequest } from "@/lib/api-helpers";
import { getSessionUserId, verifySessionToken } from "@/lib/auth";
import db from "@/lib/db";
import type { Contact, FreePBXExtension } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/agent/transfer-resolve
 *
 * Implements the dograh transfer-tool resolver contract (see the Capstone
 * repo's `docs/zeus-integration.md`, gap G3): dograh's transfer tool, when
 * configured with `destination_source: dynamic`, POSTs its resolved
 * arguments here and expects either
 *
 *     { "transfer_context": { "destination": "<dest>", "custom_message"?: "..." } }
 *
 * or a non-2xx status, which dograh turns into "I couldn't find a valid
 * destination for this transfer."
 *
 * Resolution order for `query` (a person's name, extracted by the agent):
 *   1. exact (case-insensitive) match on the account's contacts   → phone
 *   2. exact (case-insensitive) match on the account's extensions → PJSIP/<ext>
 *   3. unique substring match on contacts                         → phone
 *   4. unique substring match on extensions                       → PJSIP/<ext>
 *   5. otherwise 404
 *
 * Auth: the account's Authentik session cookie, or the same signed session
 * token in `Authorization: Bearer <token>` so dograh can call machine-to-
 * machine with the account token stored in its resolver credential vault.
 */
export async function POST(req: Request) {
  // Session cookie (portal) or the same signed session token in
  // Authorization: Bearer <token> (dograh machine-to-machine resolver calls).
  let userId = await getSessionUserId();
  if (!userId) {
    const authHeader = req.headers.get("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : null;
    if (token) userId = verifySessionToken(token);
  }

  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  // Accept the common key names dograh resolver arguments might use.
  const query = (
    body?.query ??
    body?.name ??
    body?.contact_name ??
    body?.person ??
    ""
  )
    ?.toString()
    .trim();

  if (!query) {
    return badRequest("query (a person's name) is required");
  }

  const contacts = db
    .prepare(
      "SELECT id, user_id, name, phone, email, notes, created_at, updated_at FROM contacts WHERE user_id = ?",
    )
    .all(userId) as Contact[];
  const extensions = db
    .prepare(
      "SELECT * FROM freepbx_extensions WHERE user_id = ?",
    )
    .all(userId) as FreePBXExtension[];

  const q = query.toLowerCase();
  const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().trim();

  // 1. Exact contact match → external number.
  const exactContact = contacts.find((c) => norm(c.name) === q);
  if (exactContact && exactContact.phone) {
    return resolve(
      normalizePhone(exactContact.phone),
      "contact",
      exactContact.name,
    );
  }

  // 2. Exact extension match → PJSIP endpoint.
  const exactExt = extensions.find(
    (e) =>
      norm(e.extension_name) === q ||
      norm(e.extension_id) === q ||
      norm(e.extension_id) === q.replace(/^ext\s*/, ""),
  );
  if (exactExt) {
    return resolve(
      `PJSIP/${exactExt.extension_id}`,
      "extension",
      exactExt.extension_name ?? exactExt.extension_id,
    );
  }

  // 3/4. Unique substring match (guarded so a generic query never guesses).
  const contactSubs = contacts.filter(
    (c) => c.phone && norm(c.name).includes(q) && q.length >= 2,
  );
  if (contactSubs.length === 1) {
    return resolve(normalizePhone(contactSubs[0].phone), "contact", contactSubs[0].name);
  }

  const extSubs = extensions.filter((e) => {
    const hay = `${norm(e.extension_name)} ${norm(e.extension_id)}`;
    return hay.includes(q) && q.length >= 2;
  });
  if (extSubs.length === 1) {
    return resolve(
      `PJSIP/${extSubs[0].extension_id}`,
      "extension",
      extSubs[0].extension_name ?? extSubs[0].extension_id,
    );
  }

  return NextResponse.json(
    {
      error: "no_match",
      message: `No contact or extension matches "${query}" for this account.`,
    },
    { status: 404 },
  );
}

function resolve(
  destination: string,
  source: "contact" | "extension",
  matchedName: string,
): NextResponse {
  return NextResponse.json({
    transfer_context: {
      destination,
      custom_message: `Connecting you to ${matchedName}.`,
      source,
      matched_name: matchedName,
    },
  });
}

/** Light E.164 normalization: keep +, strip spaces/dashes/parens/dots. */
function normalizePhone(phone: string): string {
  const cleaned = phone.replace(/[\s\-().]/g, "");
  if (/^\d{10}$/.test(cleaned)) return `+1${cleaned}`;
  return cleaned;
}