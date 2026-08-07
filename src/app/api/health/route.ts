import { NextResponse } from "next/server";
import db from "@/lib/db";
import { getAmiClient } from "@/lib/ami";

export const dynamic = "force-dynamic";

interface ProbeResult {
  status: "ok" | "degraded" | "down";
  latency_ms: number;
  error?: string;
}

interface HealthResponse {
  status: "ok" | "degraded" | "down";
  uptime_seconds: number;
  timestamp: string;
  services: {
    database: ProbeResult;
    voipms_api: ProbeResult;
    freepbx_api: ProbeResult;
    asterisk_ami: ProbeResult;
    stripe: ProbeResult;
  };
}

const startTime = Date.now();

async function probe(
  name: string,
  fn: () => Promise<void>,
): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    await fn();
    return { status: "ok", latency_ms: Date.now() - t0 };
  } catch (e) {
    return {
      status: "down",
      latency_ms: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function GET() {
  // ── Database (SQLite) ──────────────────────────────────────
  const dbResult = await probe("database", async () => {
    const row = db.prepare("SELECT 1 as ok").get() as { ok: number };
    if (row.ok !== 1) throw new Error("Unexpected query result");
  });

  // ── VoIP.ms API ────────────────────────────────────────────
  const voipmsResult = await probe("voipms_api", async () => {
    const user = process.env.VOIPMS_API_USERNAME;
    const pass = process.env.VOIPMS_API_PASSWORD;
    if (!user || !pass) throw new Error("VOIPMS_API_USERNAME or VOIPMS_API_PASSWORD not set");

    const url = new URL("https://voip.ms/api/v1/rest.php");
    url.searchParams.set("api_username", user);
    url.searchParams.set("api_password", pass);
    url.searchParams.set("method", "getAccountInfo");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    try {
      const res = await fetch(url.toString(), {
        signal: controller.signal,
      });
      if (!res.ok)
        throw new Error(`VoIP.ms API returned ${res.status}`);
      const data = (await res.json()) as { status?: string };
      if (data.status !== "success")
        throw new Error(`VoIP.ms API: ${data.status ?? "unknown"}`);
    } finally {
      clearTimeout(timeout);
    }
  });

  // ── FreePBX API ────────────────────────────────────────────
  const freepbxResult = await probe("freepbx_api", async () => {
    const url = process.env.FREEPBX_URL;
    const clientId = process.env.FREEPBX_CLIENT_ID;
    const clientSecret = process.env.FREEPBX_CLIENT_SECRET;
    if (!url || !clientId || !clientSecret)
      throw new Error("FREEPBX_URL, FREEPBX_CLIENT_ID, or FREEPBX_CLIENT_SECRET not set");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    try {
      const res = await fetch(
        `${url.replace(/\/$/, "")}/admin/api/api/oauth2/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "client_credentials",
            client_id: clientId,
            client_secret: clientSecret,
          }),
          signal: controller.signal,
        },
      );
      if (!res.ok)
        throw new Error(`FreePBX OAuth2 returned ${res.status}`);
      const data = (await res.json()) as { access_token?: string };
      if (!data.access_token)
        throw new Error("No access_token in FreePBX response");
    } finally {
      clearTimeout(timeout);
    }
  });

  // ── Asterisk AMI ───────────────────────────────────────────
  const amiResult = await probe("asterisk_ami", async () => {
    const ami = getAmiClient();
    if (!ami.isConnected) {
      // Check if AMI is configured
      const host = process.env.ASTERISK_AMI_HOST;
      if (!host) {
        // AMI not configured — not an error, just degraded
        return;
      }
      throw new Error(`AMI not connected to ${host}:${process.env.ASTERISK_AMI_PORT || "5038"}`);
    }
    // AMI is connected
  });

  // ── Stripe (config check only) ─────────────────────────────
  const stripeResult = await probe("stripe", async () => {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY not set");
    // Verify it looks like a valid Stripe secret key
    if (!key.startsWith("sk_") && !key.startsWith("rk_"))
      throw new Error("STRIPE_SECRET_KEY does not match expected format");
    // Optional: verify the webhook secret is set too
    const wh = process.env.STRIPE_WEBHOOK_SECRET;
    if (!wh) throw new Error("STRIPE_WEBHOOK_SECRET not set");
  });

  // ── Aggregate status ───────────────────────────────────────
  const services: HealthResponse["services"] = {
    database: dbResult,
    voipms_api: voipmsResult,
    freepbx_api: freepbxResult,
    asterisk_ami: amiResult,
    stripe: stripeResult,
  };

  const downCount = Object.values(services).filter((s) => s.status === "down").length;

  let overall: HealthResponse["status"] = "ok";
  if (downCount > 0) overall = "degraded";
  if (downCount >= 2) overall = "down";

  const response: HealthResponse = {
    status: overall,
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    timestamp: new Date().toISOString(),
    services,
  };

  const httpStatus = overall === "ok" ? 200 : overall === "degraded" ? 200 : 503;
  return NextResponse.json(response, { status: httpStatus });
}
