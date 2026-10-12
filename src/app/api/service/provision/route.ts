import { NextResponse } from "next/server";
import { z } from "zod";
import { requireServiceScope } from "@/lib/api-helpers";
import { SCOPE } from "@/lib/service-auth";
import { provisionNumber } from "@/lib/phone-provisioning";

export const dynamic = "force-dynamic";

/**
 * `POST /api/service/provision` — give an account the number it just bought.
 *
 * Magnate (the billing platform) calls this from its Stripe webhook once a
 * subscription to a `service: "zeus"` plan is active. It is the only route that
 * acts on an account named in its request rather than on the token's own, and
 * the scope says so: `numbers:provision`.
 *
 * Body:
 *
 *   { "email": "buyer@example.com",   // required — the identity on Magnate
 *     "name": "Ada Lovelace",         // optional; defaults to the address
 *     "plan": "consumer",             // optional; the plan the purchase bought
 *     "did": "4132642700",            // optional; a specific line to hand out
 *     "area_code": "413" }            // optional; a preference, not a promise
 *
 * Answers 201 when the account was created by this call, 200 when it already
 * existed (including the idempotent case), and the refusal's own status
 * otherwise: 400 for a body that is not a purchase, 409 for a line that is
 * taken or reserved, 502 when VoIP.ms cannot be asked, 503 when the pool has no
 * free line. A caller that retries a webhook gets the same number back rather
 * than a second one — see `lib/phone-provisioning.ts`.
 */
const schema = z.object({
  email: z.string().email("A buyer email is required").max(254),
  name: z.string().trim().max(120).optional(),
  plan: z.string().trim().max(32).optional(),
  did: z.string().trim().max(24).optional(),
  area_code: z.string().trim().max(8).optional(),
});

export async function POST(req: Request) {
  const { error } = requireServiceScope(req, SCOPE.numbersProvision);
  if (error) return error;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  const { email, name, plan, did, area_code } = parsed.data;
  const result = await provisionNumber({
    email,
    name,
    plan,
    did,
    areaCode: area_code,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json(result, { status: result.account_created ? 201 : 200 });
}
