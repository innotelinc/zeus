/**
 * OpenSMS client — the Android-phone SMS gateway.
 *
 * OpenSMS (https://github.com/daslearning-org/OpenSMS) turns a phone into an
 * HTTP SMS sender: `POST /sms/` with `Authorization: Bearer <key>` and
 * `{ "number": "...", "text": "..." }`, answered with `{ "stat": true }`.
 * It has **no inbound surface** — replies still arrive through the VoIP.ms
 * webhook — so this is an outbound transport only.
 *
 * Config:
 *   OPENSMS_URL         gateway root, e.g. http://192.168.1.50:9292
 *                       (with or without the /sms path)
 *   OPENSMS_API_KEY     key generated in the app (vault:// supported)
 *   OPENSMS_TIMEOUT_MS  request budget (default 15 s)
 *
 * Selection between this and the FreePBX trunk lives in `sms.ts`
 * (`SMS_PROVIDER`).
 */

const DEFAULT_TIMEOUT_MS = 15_000;

/** A failure that came from the gateway or its configuration. */
export class OpenSmsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenSmsError";
  }
}

/** The configured gateway root, or null when OpenSMS is not configured. */
export function openSmsBaseUrl(): string | null {
  const url = (process.env.OPENSMS_URL ?? "").trim().replace(/\/+$/, "");
  return url || null;
}

/** True when both the gateway URL and its API key are set. */
export function isOpenSmsConfigured(): boolean {
  return Boolean(openSmsBaseUrl() && (process.env.OPENSMS_API_KEY ?? "").trim());
}

/**
 * Normalize the gateway URL to the endpoint OpenSMS actually serves.
 *
 * The FastAPI route is `/sms/` and the router does not answer `/sms`, so the
 * slash is part of the contract. Accepting the root and the `/sms` suffix
 * keeps both `.env` shapes working.
 */
export function openSmsEndpoint(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new OpenSmsError(
      `OPENSMS_URL must be an http(s) URL (got "${base}")`,
    );
  }
  return /\/sms$/i.test(trimmed) ? `${trimmed}/` : `${trimmed}/sms/`;
}

/** The gateway's own view of its modem, from the unauthenticated `GET /health`. */
export interface OpenSmsHealth {
  ok: boolean;
  backend: string | null;
  detail: string;
  signal: number | null;
  operator: string | null;
}

/**
 * Ask the gateway whether it can actually send right now.
 *
 * Health lives at the root, so the configured URL is stripped of a `/sms`
 * suffix first. It never throws: a failed probe is a health answer of its own
 * (`ok: false` plus the reason), which is what the composer shows.
 */
export async function checkOpenSms(timeoutMs = 2_500): Promise<OpenSmsHealth> {
  const base = openSmsBaseUrl();
  if (!base) {
    return {
      ok: false,
      backend: null,
      detail: "OPENSMS_URL is not set",
      signal: null,
      operator: null,
    };
  }

  let endpoint: string;
  try {
    endpoint = `${openSmsEndpoint(base).replace(/\/sms\/$/i, "")}/health`;
  } catch (e) {
    return {
      ok: false,
      backend: null,
      detail: e instanceof Error ? e.message : String(e),
      signal: null,
      operator: null,
    };
  }

  const failed = (detail: string): OpenSmsHealth => ({
    ok: false,
    backend: null,
    detail,
    signal: null,
    operator: null,
  });

  try {
    const res = await fetch(endpoint, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    const raw = await res.text().catch(() => "");
    let payload: Record<string, unknown> | null = null;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return failed(
        res.ok
          ? `unexpected health answer from ${endpoint}`
          : `HTTP ${res.status} from ${endpoint}`,
      );
    }
    if (!payload || typeof payload !== "object") {
      return failed(`unexpected health answer from ${endpoint}`);
    }
    return {
      // The gateway answers 503 when it has no modem, and `ok` says the same.
      ok: payload.ok === true,
      backend: typeof payload.backend === "string" ? payload.backend : null,
      detail:
        typeof payload.detail === "string" ? payload.detail : "not ready",
      signal: typeof payload.signal === "number" ? payload.signal : null,
      operator:
        typeof payload.operator === "string" ? payload.operator : null,
    };
  } catch (e) {
    return failed(
      `unreachable at ${endpoint}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function timeoutMs(): number {
  const raw = Number(process.env.OPENSMS_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/** Send one SMS through the gateway; resolves when OpenSMS accepts it. */
export async function sendOpenSms(params: {
  to: string;
  body: string;
}): Promise<{ stat: true }> {
  const base = openSmsBaseUrl();
  const apiKey = (process.env.OPENSMS_API_KEY ?? "").trim();
  if (!base || !apiKey) {
    throw new OpenSmsError(
      "OpenSMS is not configured — set OPENSMS_URL and OPENSMS_API_KEY",
    );
  }

  const endpoint = openSmsEndpoint(base);
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ number: params.to, text: params.body }),
      signal: AbortSignal.timeout(timeoutMs()),
      cache: "no-store",
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new OpenSmsError(`OpenSMS gateway unreachable at ${endpoint}: ${reason}`);
  }

  const raw = await res.text().catch(() => "");
  if (!res.ok) {
    // 401 is the one failure worth naming: a rotated key is the usual cause,
    // and the gateway's own detail is a bare "Invalid or expired API key".
    const hint =
      res.status === 401 ? " — check OPENSMS_API_KEY" : "";
    throw new OpenSmsError(
      `OpenSMS returned HTTP ${res.status}${hint}${
        raw ? `: ${raw.slice(0, 200)}` : ""
      }`,
    );
  }

  let payload: { stat?: unknown; error?: unknown; detail?: unknown } | null =
    null;
  try {
    payload = JSON.parse(raw) as {
      stat?: unknown;
      error?: unknown;
      detail?: unknown;
    };
  } catch {
    throw new OpenSmsError(
      `OpenSMS returned a non-JSON answer: ${raw.slice(0, 200)}`,
    );
  }

  // The app answers 200 even when the phone refused to hand the message to
  // the carrier, so `stat` is the actual result. The Linux gateway (and the
  // Android app on some failures) names the reason in `error` — carry it, so
  // "no SIM" or "no signal" reaches the composer toast instead of a guess.
  if (payload?.stat !== true) {
    const detail = [payload?.error, payload?.detail]
      .find((v): v is string => typeof v === "string" && v.trim() !== "");
    throw new OpenSmsError(
      detail
        ? `OpenSMS reported the message was not sent: ${detail}`
        : "OpenSMS reported the message was not sent (stat=false) — check the phone's SMS permission and signal",
    );
  }

  return { stat: true };
}
