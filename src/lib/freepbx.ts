/**
 * FreePBX GraphQL API client.
 *
 * Uses the PBX API module (FreePBX 15+) with OAuth 2.0 client credentials.
 *
 * Required env vars:
 *   FREEPBX_URL       – base URL of the FreePBX server
 *   FREEPBX_CLIENT_ID – OAuth2 client ID
 *   FREEPBX_CLIENT_SECRET – OAuth2 client secret
 */

let cachedToken: { access_token: string; expires_at: number } | null = null;

function baseUrl(): string {
  const url = process.env.FREEPBX_URL;
  if (!url) throw new Error("FREEPBX_URL must be set");
  return url.replace(/\/$/, "");
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expires_at > Date.now() + 30_000) {
    return cachedToken.access_token;
  }

  const client_id = process.env.FREEPBX_CLIENT_ID;
  const client_secret = process.env.FREEPBX_CLIENT_SECRET;
  if (!client_id || !client_secret) {
    throw new Error(
      "FREEPBX_CLIENT_ID and FREEPBX_CLIENT_SECRET must be set",
    );
  }

  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("client_id", client_id);
  body.set("client_secret", client_secret);

  const res = await fetch(`${baseUrl()}/admin/api/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`FreePBX OAuth error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };

  cachedToken = {
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
  };

  return cachedToken.access_token;
}

async function gql<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${baseUrl()}/admin/ajax.php?module=api&command=gql`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`FreePBX GQL error: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(
      `FreePBX GQL: ${json.errors.map((e: { message: string }) => e.message).join(", ")}`,
    );
  }
  return json.data as T;
}

// ---- Types ----

// Mirrors the FreePBX 17 api module's `addExtensionInput` GraphQL type.
// NOTE: there is NO `secret` field here — the FreePBX device secret is
// auto-generated. The WebRTC softphone authenticates against the WSS
// endpoint config the portal writes itself (with its own secret).
export interface AddExtensionInput {
  extensionId: string;
  name: string;
  email: string;
  tech?: "pjsip" | "sip";
  callerID?: string;
  outboundCid?: string;
  emergencyCid?: string;
  vmEnable?: boolean;
  vmPassword?: string;
  umEnable?: boolean;
  umPassword?: string;
  maxContacts?: number;
}

export interface AddExtensionResult {
  addExtension: {
    status: boolean;
    message: string;
  };
}

// ---- API methods ----

/** Create a new SIP (PJSIP) extension. */
export async function addExtension(
  input: AddExtensionInput,
): Promise<AddExtensionResult> {
  const mutation = `
    mutation AddExtension($input: addExtensionInput!) {
      addExtension(input: $input) {
        status
        message
      }
    }
  `;
  return gql<AddExtensionResult>(mutation, { input });
}

/** Delete an extension by ID. */
export async function deleteExtension(
  extensionId: string,
): Promise<{ deleteExtension: { status: boolean; message: string } }> {
  return gql(
    `mutation DeleteExtension($input: deleteExtensionInput!) {
      deleteExtension(input: $input) {
        status
        message
      }
    }`,
    { input: { extensionId } },
  );
}

// ---- Extension list (Core module's `fetchAllExtensions`) ----

/** One extension as the Core API returns it. */
export interface FreePbxExtensionRow {
  extensionId: string;
  tech: string;
}

/**
 * Every extension FreePBX knows about, from the Core module's own query.
 *
 * This is the read the provisioning preflight needs and the portal never had:
 * `POST /api/phone/extensions` used to create blind. The API is FreePBX's own
 * answer to "what extensions exist", so the portal is asking the authority
 * rather than re-deriving it from tables it cannot see.
 *
 * The response is normalised defensively — the api module has shipped the rows
 * both as `{ extension: [ … ] }` (what FreePBX 17 returns) and as a bare list,
 * and each row both as `{ extension: { … } }` and flat — because a shape change
 * must surface as "the preflight could not read the PBX" (a refusal), never as
 * "no extensions exist" (a create over an existing number). A malformed body is
 * therefore an error, not an empty list.
 *
 * The top-level wrapper is the shape this read got wrong first: measured on
 * `.30`, `data.fetchAllExtensions` is `{"extension":[…]}` for all eight
 * extensions, so an `Array.isArray` on it threw and `/api/health` reported the
 * create gate degraded — every extension Add refused with a 503 while the PBX
 * answered the query perfectly well.
 */
export async function fetchAllExtensions(): Promise<FreePbxExtensionRow[]> {
  const query = `query { fetchAllExtensions { extension { extensionId tech } } }`;
  const data = await gql<{ fetchAllExtensions?: unknown }>(query);

  const raw = data?.fetchAllExtensions;
  const wrapped = (raw as { extension?: unknown } | null | undefined)?.extension;
  const list = Array.isArray(raw) ? raw : Array.isArray(wrapped) ? wrapped : null;
  if (list === null) {
    throw new Error(
      "fetchAllExtensions did not return a list — the PBX API's shape is not what " +
        "this preflight reads, so it cannot tell whether an extension exists",
    );
  }

  const rows: FreePbxExtensionRow[] = [];
  for (const entry of list) {
    const row = (entry as { extension?: unknown })?.extension ?? entry;
    const extensionId = String((row as { extensionId?: unknown })?.extensionId ?? "").trim();
    if (!extensionId) continue;
    rows.push({ extensionId, tech: String((row as { tech?: unknown })?.tech ?? "").trim() });
  }
  return rows;
}

