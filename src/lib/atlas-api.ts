/**
 * Atlas cross-system API client.
 *
 * The PBX portal calls Atlas for customer signup coordination.
 * When a user signs up for phone service on the PBX portal,
 * Atlas is notified to create a corresponding account or company.
 *
 * Required env vars:
 *   ATLAS_API_URL  – URL of the Atlas platform (e.g. http://localhost:3000)
 *   ATLAS_API_KEY  – shared secret for API authentication
 */

const ATLAS_URL = (process.env.ATLAS_API_URL ?? "http://localhost:3000").replace(
  /\/$/,
  "",
);

function apiKey(): string {
  const key = process.env.ATLAS_API_KEY;
  if (!key) throw new Error("ATLAS_API_KEY must be set");
  return key;
}

async function callAtlas<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${ATLAS_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey(),
      "X-PBX-Origin": "pbx-portal",
    },
    ...options,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      `Atlas API error (${res.status}): ${(body as { error?: string }).error ?? res.statusText}`,
    );
  }

  return res.json() as Promise<T>;
}

// ---- Types ----

export interface AtlasSignupPayload {
  email: string;
  name: string;
  plan: "consumer" | "business";
  phone?: string;
  pbx_user_id: string;
  dids?: string[];
  extension_id?: string;
}

export interface AtlasSignupResponse {
  success: boolean;
  atlas_user_id?: string;
  atlas_company_id?: string;
  message?: string;
}

// ---- API methods ----

/**
 * Notify Atlas of a new PBX customer signup.
 * Atlas can create a user account and optionally a company based on the plan.
 */
export async function notifyAtlasSignup(
  payload: AtlasSignupPayload,
): Promise<AtlasSignupResponse> {
  return callAtlas<AtlasSignupResponse>("/api/pbx/signup", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/**
 * Update Atlas with provisioning status for a PBX customer.
 */
export async function notifyAtlasProvisioning(params: {
  pbx_user_id: string;
  did?: string;
  extension_id?: string;
  status: string;
}): Promise<{ success: boolean }> {
  return callAtlas("/api/pbx/provisioning", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

/**
 * Get Atlas customer status.
 */
export async function getAtlasCustomerStatus(
  pbxUserId: string,
): Promise<{ found: boolean; data?: Record<string, unknown> }> {
  return callAtlas(`/api/pbx/customers/${pbxUserId}`, {
    method: "GET",
  });
}
