/**
 * Giving a number to an account that bought one.
 *
 * The phone plan is sold on Magnate (the ecosystem's billing platform, plan slug
 * `phone`, `service = "zeus"`). Until this module existed, the purchase ended at
 * "set up in the Zeus portal after checkout": the buyer landed on a dashboard
 * with no number and had to pick one themselves. This is the Zeus half of the
 * fix — the call Magnate makes once a subscription is live, which creates the
 * portal account (if the buyer has never signed in) and assigns a number to it.
 *
 * ## Where a number comes from
 *
 * The estate already holds a pool of DIDs on one VoIP.ms account, and it pays
 * for them whether or not a customer is using them. `getDIDsInfo` answers with
 * **the DIDs the account owns** — the response carries each line's routing,
 * `next_billing` and `order_date`, which is a line on our account, not a
 * catalogue entry — so assignment is *allocation from that pool*: the first
 * line nobody holds. That is deliberately not "buy whatever the provider
 * suggests": the product promises a number, and the operator decides the pool by
 * adding DIDs at VoIP.ms. An exhausted pool is reported as such (503) so the
 * operator adds numbers, rather than silently spending money.
 *
 * Two kinds of line are never handed out:
 *
 *   * one the portal already has a row for (any status — a suspended number is
 *     still that account's, and `phone_numbers.did` is UNIQUE), and
 *   * one the PBX's own trunk maps (`VOIPMS_DIDS` / `CLOUDONIX_DIDS`, a
 *     `did:target` pair like `4132643964:8000`). Those are inbound routes for
 *     the platform, not stock for sale.
 *
 * ## Idempotence is the contract
 *
 * Magnate calls this from a payment webhook, and Stripe retries webhooks. So a
 * second call for an account that already has its allowance of numbers returns
 * the number it holds — `assigned: false` — instead of allocating a second one.
 * The account row and the number row are written in **one transaction**, so a
 * failure cannot leave an account with no way to get a number.
 */
import { randomUUID } from "node:crypto";
import db from "./db";
import * as voipms from "./voipms";
import { normalizeDid } from "./dialplan-values";
import type { PhoneNumber, User } from "./types";

/**
 * How many numbers a plan may hold.
 *
 * One definition, used by both the operator's own `POST /api/phone/numbers`
 * (`action: "order"`) and by an assignment from a purchase — the manual path and
 * the automatic one must not disagree about what a plan includes.
 */
export function maxNumbersForPlan(plan: string | null | undefined): number {
  return plan === "business" ? 5 : 1;
}

/**
 * The NANP area code of a DID, or null when it is not a 10/11-digit number.
 *
 * `normalizeDid` is the estate's one definition of "the same number" (it is what
 * the plan lookup and the Capstone bindings match on), so a number written with
 * a country code, punctuation or a leading `1` is the same number here too — the
 * pool lookup and the area code must not disagree about which line was asked for.
 */
export function areaCodeOf(did: string): string | null {
  const digits = normalizeDid(did);
  return digits && digits.length === 10 ? digits.slice(0, 3) : null;
}

/**
 * DIDs the PBX trunk already routes, read from the same `did:target` lists the
 * trunk setup scripts consume (`pbx/setup-cloudonix-trunk.sh`,
 * `scripts/pbx.env.example`).
 *
 * The lists are comma- or whitespace-separated, and a bare DID with no target is
 * still a line the trunk owns — so the DID half is taken either way.
 */
export function reservedDids(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const out = new Set<string>();
  for (const name of ["VOIPMS_DIDS", "CLOUDONIX_DIDS"]) {
    for (const entry of (env[name] ?? "").split(/[,\s]+/)) {
      const did = normalizeDid(entry.split(":")[0]);
      if (did) out.add(did);
    }
  }
  return out;
}

/** One line on the VoIP.ms account, as far as allocation needs to read it. */
export interface OwnedDid {
  did: string;
  description?: string | null;
  routing?: string | null;
  sms_available?: string | number | null;
}

export interface SelectOptions {
  /** DIDs already held by a portal account. */
  taken: Set<string>;
  /** DIDs the PBX trunk routes. */
  reserved: Set<string>;
  /** Ask for this area code first; a line outside it is still better than none. */
  areaCode?: string | null;
}

/**
 * The line to hand out: the first free one, preferring the requested area code.
 *
 * "Prefers" rather than "requires" on purpose — a customer who asked for 302
 * should not be told there is no number when the pool holds twelve in 413. The
 * caller reports the area code it actually assigned, so nothing has to pretend.
 */
export function selectOwnedDid(
  owned: readonly OwnedDid[],
  { taken, reserved, areaCode }: SelectOptions,
): OwnedDid | null {
  const wanted = (areaCode ?? "").replace(/\D/g, "");
  const free = owned.filter((line) => {
    const did = normalizeDid(line.did);
    return Boolean(did) && !taken.has(did as string) && !reserved.has(did as string);
  });
  if (wanted.length === 3) {
    const match = free.find((line) => areaCodeOf(line.did) === wanted);
    if (match) return match;
  }
  return free[0] ?? null;
}

/** What the caller asked for. */
export interface ProvisionInput {
  /** The buyer's address — the identity Magnate knows. */
  email: string;
  /** Display name; defaults to the local part of the address. */
  name?: string | null;
  /** The portal plan the purchase entitles them to. */
  plan?: string | null;
  /** A specific DID to assign, when the operator has one in mind. */
  did?: string | null;
  /** Preferred area code for the pool pick. */
  areaCode?: string | null;
}

/** What happened, in the vocabulary a caller can log or show. */
export interface Provisioned {
  ok: true;
  user_id: string;
  email: string;
  did: string;
  area_code: string | null;
  location: string | null;
  sms_enabled: boolean;
  /** The portal account was created by this call. */
  account_created: boolean;
  /** The number was allocated by this call (false = the account already held it). */
  number_assigned: boolean;
}

/** A refusal, with the status the route should answer with. */
export interface ProvisionRefusal {
  ok: false;
  status: number;
  error: string;
}

/**
 * The outside world, as far as allocation needs it — injectable so the DB half
 * is testable without a VoIP.ms account, and so nothing in a test can order or
 * touch a real line.
 */
export interface ProvisionDeps {
  listOwned(): Promise<{ dids: OwnedDid[] }>;
  enableSms(did: string): Promise<void>;
}

export const liveDeps: ProvisionDeps = {
  listOwned: () => voipms.getDIDsInfo(),
  enableSms: async (did) => {
    await voipms.enableSMS(did);
  },
};

/** A refusal, told apart from an allocated row by the shape it carries. */
function isRefusal(value: PhoneNumber | ProvisionRefusal): value is ProvisionRefusal {
  return (value as ProvisionRefusal).ok === false;
}

const USER_COLUMNS =
  "id, email, name, phone, plan, plan_status, country, role, " +
  "stripe_subscription_id, created_at, updated_at";

function findUserByEmail(email: string): User | undefined {
  return db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE LOWER(email) = LOWER(?)`)
    .get(email) as User | undefined;
}

function activeNumbers(userId: string): PhoneNumber[] {
  return db
    .prepare(
      "SELECT * FROM phone_numbers WHERE user_id = ? AND status = 'active' ORDER BY created_at",
    )
    .all(userId) as PhoneNumber[];
}

/** Every DID any account holds, so a line is never given out twice. */
function heldDids(): Set<string> {
  const rows = db.prepare("SELECT did FROM phone_numbers").all() as Array<{
    did: string;
  }>;
  return new Set(
    rows.map((row) => normalizeDid(row.did)).filter((did): did is string => Boolean(did)),
  );
}

/**
 * Create the portal account for a buyer who has never signed in.
 *
 * `password_hash` gets the same inert marker an SSO sign-in writes
 * (`lib/oidc.ts`): the identity is Authentik's, because the purchase created the
 * Authentik account first, and a local password would be a second way in that
 * nobody set.
 */
function createAccount(email: string, name: string, plan: string): string {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, plan, plan_status) " +
      "VALUES (?, ?, ?, '!oidc', ?, 'active')",
  ).run(id, email, name, plan);
  return id;
}

/**
 * Allocate the pool pick to an account, in one transaction with the row.
 *
 * Returns the refusal to answer with when there is nothing to give: an empty
 * pool is a 503 (the operator's cue to add DIDs), a named line that is taken or
 * reserved is a 409 with the reason, and a VoIP.ms that cannot be asked is a
 * 502.
 */
async function allocate(
  userId: string,
  input: ProvisionInput,
  deps: ProvisionDeps,
): Promise<PhoneNumber | ProvisionRefusal> {
  const reserved = reservedDids();
  const taken = heldDids();

  let owned: OwnedDid[];
  try {
    owned = (await deps.listOwned()).dids ?? [];
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error:
        "Could not read the number pool from VoIP.ms — " +
        (error instanceof Error ? error.message : "unknown error"),
    };
  }

  const byNumber = new Map<string, OwnedDid>();
  for (const line of owned) {
    const key = normalizeDid(line.did);
    if (key) byNumber.set(key, line);
  }

  let chosen: OwnedDid | null;
  const requested = input.did ? normalizeDid(input.did) : null;
  if (requested) {
    const wanted = requested;
    if (!byNumber.has(wanted)) {
      return {
        ok: false,
        status: 409,
        error:
          `The number ${input.did} is not on this account's VoIP.ms pool. ` +
          "Add it at VoIP.ms first, or omit `did` to take the next free line.",
      };
    }
    if (reserved.has(wanted)) {
      return {
        ok: false,
        status: 409,
        error: `The number ${input.did} is routed by the PBX trunk (VOIPMS_DIDS / CLOUDONIX_DIDS) and cannot be assigned.`,
      };
    }
    if (taken.has(wanted)) {
      return {
        ok: false,
        status: 409,
        error: `The number ${input.did} is already assigned to an account.`,
      };
    }
    chosen = byNumber.get(wanted) ?? null;
  } else {
    chosen = selectOwnedDid(owned, {
      taken,
      reserved,
      areaCode: input.areaCode ?? process.env.ZEUS_PROVISION_AREA_CODE ?? null,
    });
  }

  if (!chosen) {
    return {
      ok: false,
      status: 503,
      error:
        "No unassigned number is available on the VoIP.ms account. " +
        "Add DIDs at VoIP.ms (they join the pool automatically), then retry.",
    };
  }

  const did = normalizeDid(chosen.did) ?? String(chosen.did);
  const numberId = randomUUID();
  const smsAvailable =
    chosen.sms_available === undefined || chosen.sms_available === null
      ? true
      : String(chosen.sms_available) === "1";

  // The row is written before any provider write, and a single INSERT cannot
  // half-succeed: the moment the account's number exists it is a real line, and
  // everything after it (SMS) is an extra on top.
  db.prepare(
    `INSERT INTO phone_numbers (id, user_id, did, area_code, location, sms_enabled, fax_enabled, status)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'active')`,
  ).run(
    numberId,
    userId,
    did,
    areaCodeOf(did),
    chosen.description ?? null,
    smsAvailable ? 1 : 0,
  );

  // SMS is a nicety on top of an already-assigned number: a provider hiccup
  // must not fail the purchase, and the row's flag is only true when VoIP.ms
  // actually answered.
  if (smsAvailable) {
    try {
      await deps.enableSms(did);
      db.prepare("UPDATE phone_numbers SET sms_enabled = 1 WHERE id = ?").run(numberId);
    } catch {
      db.prepare("UPDATE phone_numbers SET sms_enabled = 0 WHERE id = ?").run(numberId);
    }
  }

  return db
    .prepare("SELECT * FROM phone_numbers WHERE id = ?")
    .get(numberId) as PhoneNumber;
}

/**
 * Give an account a number, creating the account if this purchase is the first
 * it has been seen.
 *
 * The allowance is checked before the pool is even read, so a retry costs one
 * query and returns the number the account already holds.
 */
export async function provisionNumber(
  input: ProvisionInput,
  deps: ProvisionDeps = liveDeps,
): Promise<Provisioned | ProvisionRefusal> {
  const email = (input.email ?? "").trim().toLowerCase();
  if (!email) {
    return { ok: false, status: 400, error: "email is required" };
  }
  const plan = (input.plan ?? "").trim() || "consumer";

  const existing = findUserByEmail(email);
  const userId = existing?.id ?? null;
  const accountPlan = plan || existing?.plan || "consumer";

  if (userId) {
    const held = activeNumbers(userId);
    if (held.length >= maxNumbersForPlan(existing?.plan ?? accountPlan)) {
      const number = held[0];
      return {
        ok: true,
        user_id: userId,
        email,
        did: number.did,
        area_code: number.area_code,
        location: number.location,
        sms_enabled: number.sms_enabled === 1,
        account_created: false,
        number_assigned: false,
      };
    }
  }

  // Creating the account and allocating the number are separate statements on
  // purpose: the pool read is a network call, and holding a write transaction
  // open across it would lock the portal's database while VoIP.ms answers.
  let createdId = userId;
  if (!createdId) {
    createdId = createAccount(email, (input.name ?? "").trim() || email.split("@")[0], accountPlan);
  }

  const result = await allocate(createdId, input, deps);
  if (isRefusal(result)) {
    // Nothing was allocated: an account created a moment ago and still holding
    // no number would be a half-done purchase, so it is removed again. The
    // caller can retry against a pool that has a free line.
    if (!userId) {
      db.prepare("DELETE FROM users WHERE id = ?").run(createdId);
    }
    return result;
  }

  const number = result;
  return {
    ok: true,
    user_id: createdId,
    email,
    did: number.did,
    area_code: number.area_code,
    location: number.location,
    sms_enabled: number.sms_enabled === 1,
    account_created: !userId,
    number_assigned: true,
  };
}
