/**
 * VoIP.ms REST API client for PBX portal.
 *
 * Uses main account (VOIPMS_API_USERNAME / VOIPMS_API_PASSWORD) for all
 * REST API calls (provisioning, DID management, SMS, CDRs).
 *
 * SIP trunk registration uses the sub-account (VOIPMS_SIP_USER / VOIPMS_SIP_PASS)
 * against VOIPMS_SIP_SERVER (e.g. newyork1.voip.ms). These are consumed by
 * setup.sh for PJSIP config generation, not by this REST client.
 *
 * API docs: https://voip.ms/m/apidocs.php
 */

const BASE_URL = "https://voip.ms/api/v1/rest.php";

function credentials(): { api_username: string; api_password: string } {
  const api_username = process.env.VOIPMS_API_USERNAME;
  const api_password = process.env.VOIPMS_API_PASSWORD;
  if (!api_username || !api_password) {
    throw new Error("VOIPMS_API_USERNAME and VOIPMS_API_PASSWORD must be set");
  }
  return { api_username, api_password };
}

/** SIP trunk sub-account credentials (for PJSIP registration, not REST API). */
export function getSipCredentials() {
  return {
    sipUser: process.env.VOIPMS_SIP_USER ?? null,
    sipPass: process.env.VOIPMS_SIP_PASS ?? null,
    sipServer: process.env.VOIPMS_SIP_SERVER ?? "newyork1.voip.ms",
    mainAccount: process.env.VOIPMS_MAIN_ACCOUNT ?? null,
  };
}

async function call<T = unknown>(
  method: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T> {
  const creds = credentials();
  const searchParams = new URLSearchParams();
  searchParams.set("api_username", creds.api_username);
  searchParams.set("api_password", creds.api_password);
  searchParams.set("method", method);

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) searchParams.set(k, String(v));
  }

  const url = `${BASE_URL}?${searchParams.toString()}`;
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) {
    throw new Error(`VoIP.ms API error: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  if (data.status !== "success") {
    throw new Error(
      `VoIP.ms ${method}: ${data.status ?? "unknown error"}`,
    );
  }
  return data as T;
}

// ---- Types ----

export interface VoipMsDid {
  did: string;
  ratecenter: string;
  province: string;
  country: string;
  setup: string;
  monthly: string;
  status: string;
}

export interface VoipMsServer {
  server: string;
  hostname: string;
  pop: string;
}

// ---- API methods ----

/** Get account info (balances, etc.). */
export async function getAccountInfo() {
  return call("getAccountInfo");
}

/** Get available servers. */
export async function getServersInfo(): Promise<{ servers: VoipMsServer[] }> {
  return call("getServersInfo");
}

/** Search available DIDs. */
export async function getDIDsInfo(params: {
  province?: string;
  ratecenter?: string;
  areacode?: string;
  quantity?: number;
  type?: "local" | "tollfree";
}): Promise<{ dids: VoipMsDid[] }> {
  return call("getDIDsInfo", {
    province: params.province,
    ratecenter: params.ratecenter,
    areacode: params.areacode,
    quantity: params.quantity ?? 10,
    type: params.type ?? "local",
  });
}

/** Order (purchase) a DID. */
export async function orderDID(did: string): Promise<{ did: string }> {
  return call("orderDID", { did });
}

/** Get all DIDs on the account. */
export async function getDIDs(): Promise<{ dids: VoipMsDid[] }> {
  return call("getDIDs");
}

/** Enable SMS on a DID. */
export async function enableSMS(did: string): Promise<{ status: string }> {
  return call("enableSMS", { did });
}

/** Send SMS message. */
export async function sendSMS(params: {
  did: string;
  dst: string;
  message: string;
}): Promise<{ status: string; sms_id: string }> {
  return call("sendSMS", {
    did: params.did,
    dst: params.dst,
    message: params.message,
  });
}

/** Get SMS messages for a DID (inbound/outbound). */
export async function getSMS(params: {
  did?: string;
  dst?: string;
  from?: string;
  limit?: number;
  offset?: number;
}): Promise<{ sms: Array<Record<string, string>> }> {
  return call("getSMS", {
    did: params.did,
    dst: params.dst,
    from: params.from,
    limit: params.limit ?? 50,
    offset: params.offset ?? 0,
  });
}

/** Get CDRs (Call Detail Records). */
export async function getCDR(params: {
  date_from?: string;
  date_to?: string;
  limit?: number;
  offset?: number;
}): Promise<{ cdrs: Array<Record<string, string>> }> {
  return call("getCDR", {
    date_from: params.date_from,
    date_to: params.date_to,
    limit: params.limit ?? 50,
    offset: params.offset ?? 0,
  });
}
