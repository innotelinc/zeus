/**
 * AvantFax integration module.
 *
 * AvantFax 3.4.1 + HylaFAX+ 7.0.11 + IAXModem 1.3.5.
 * Fax user provisioning, sending, and status via the API proxy
 * served by the freepbx container at /fax/api/.
 *
 * Required env vars:
 *   AVANTFAX_URL  – URL of the AvantFax web interface (e.g. http://freepbx/fax)
 */

const AVANTFAX_URL = process.env.AVANTFAX_URL ?? "http://localhost/fax";

// ---- Types ----

export interface FaxUser {
  username: string;
  email: string;
  did: string;
  password?: string;
}

export interface FaxSendResult {
  success: boolean;
  jobId?: string;
  error?: string;
}

export interface FaxStatus {
  jobId: string;
  status: string;
  pages: number;
  duration: number;
  result: string;
  created_at: string;
}

// ---- Fax provisioning ----

/**
 * Provision a new AvantFax user via the faxadduser CLI
 * (exposed through the API proxy at /fax/api/users.php).
 */
export async function createFaxUser(user: FaxUser): Promise<FaxSendResult> {
  const password = user.password ?? Math.random().toString(36).slice(2, 10);

  const res = await fetch(`${AVANTFAX_URL}/api/users.php`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "create",
      username: user.username,
      email: user.email,
      password,
      did: user.did,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return { success: false, error: err || `HTTP ${res.status}` };
  }

  const data = await res.json();
  return { success: true, jobId: data.username ?? `fax_user_${Date.now()}` };
}

/**
 * Send a fax via HylaFAX+ sendfax.
 * The file must be a local path on the freepbx server (PDF/TIFF).
 * Upload is handled by the fax/send API route before calling this.
 */
export async function sendFax(params: {
  fromDid: string;
  toNumber: string;
  fileContent: string;  // base64-encoded PDF data (cross-container safe)
  subject?: string;
}): Promise<FaxSendResult> {
  const res = await fetch(`${AVANTFAX_URL}/api/send.php`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "send",
      modem: params.fromDid,
      destination: params.toNumber,
      file_content: params.fileContent,
      file_name: "fax.pdf",
      subject: params.subject ?? "Fax",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return { success: false, error: err || `HTTP ${res.status}` };
  }

  const data = await res.json();
  return { success: true, jobId: data.job_id };
}

/**
 * Check the status of a fax job via faxstat CLI.
 */
export async function getFaxStatus(jobId: string): Promise<FaxStatus> {
  const res = await fetch(
    `${AVANTFAX_URL}/api/status.php?job_id=${encodeURIComponent(jobId)}`,
  );

  if (!res.ok) {
    return {
      jobId,
      status: "unknown",
      pages: 0,
      duration: 0,
      result: `HTTP ${res.status}`,
      created_at: new Date().toISOString(),
    };
  }

  const data = await res.json();
  const raw = (data.raw ?? "") as string;

  // Parse faxstat output: "JID  Pri Sender         Number        Pages Dials     TTS Status"
  const done = raw.includes("DONE") || raw.includes("Done");
  const failed = raw.includes("FAIL") || raw.includes("Fail") || raw.includes("ERROR");
  const pages = parseInt((raw.match(/(\d+)\s*page/) ?? ["", "0"])[1], 10) || 0;

  return {
    jobId,
    status: done ? "completed" : failed ? "failed" : "pending",
    pages,
    duration: 0,
    result: raw.slice(0, 200),
    created_at: new Date().toISOString(),
  };
}

/**
 * Get the base URL for the AvantFax web client.
 */
export function getAvantFaxClientUrl(username?: string): string {
  return username
    ? `${AVANTFAX_URL}/client/?user=${encodeURIComponent(username)}`
    : AVANTFAX_URL;
}
