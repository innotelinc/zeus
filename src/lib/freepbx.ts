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

export interface AddExtensionInput {
  extensionId: string;
  name: string;
  email: string;
  tech?: "pjsip" | "sip";
  callerID?: string;
  outboundCID?: string;
  emergencyCID?: string;
  vmEnable?: boolean;
  vmPassword?: string;
  umEnable?: boolean;
  umPassword?: string;
  maxContacts?: number;
  secret?: string;
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
    `mutation DeleteExtension($extensionId: ID!) {
      deleteExtension(extensionId: $extensionId) {
        status
        message
      }
    }`,
    { extensionId },
  );
}

/** Get extension details. */
export async function getExtension(
  extensionId: string,
): Promise<{ extension: Record<string, unknown> }> {
  return gql(
    `query GetExtension($extensionId: ID!) {
      extension(extensionId: $extensionId)
    }`,
    { extensionId },
  );
}

/** Get voicemail for an extension. */
export async function getVoicemail(
  extensionId: string,
): Promise<{ voicemails: Array<Record<string, unknown>> }> {
  return gql(
    `query GetVoicemail($extensionId: ID!) {
      voicemails(extensionId: $extensionId) {
        id
        callerid
        duration
        origtime
        recording
        transcription
      }
    }`,
    { extensionId },
  );
}
