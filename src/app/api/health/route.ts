import { NextResponse } from "next/server";
import db from "@/lib/db";
import { getAmiClient } from "@/lib/ami";
import { avaAdminBase, avaConfigured, listAgents } from "@/lib/ava";

export const dynamic = "force-dynamic";

// The voice engine, from the portal container. The engine is host-networked
// and binds its health port on every interface (HEALTH_BIND_HOST=0.0.0.0 in
// compose), so the bridge gateway reaches it; AVA_ADMIN_URL is the address the
// portal talks to the admin API on (see docker-compose.yml — inside a
// container that is a service name, not the host's loopback).
const AVA_ENGINE_URL = (process.env.AVA_ENGINE_URL ?? "http://host.docker.internal:15000").replace(/\/+$/, "");

interface EngineHealth {
  status?: string;
  ari_connected?: boolean;
  default_ready?: boolean;
  audiosocket?: { listening?: boolean };
}

/**
 * The engine's own verdict, plus the two things it reports separately because
 * they fail without changing its `status`: an engine that never attached to
 * ARI, and one whose AudioSocket transport is not listening. Both mean the
 * same thing to a caller — the call is never answered — while the process
 * looks perfectly healthy.
 */
async function probeAvaEngine(): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${AVA_ENGINE_URL}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) throw new Error(`engine health returned ${res.status}`);
    const body = (await res.json()) as EngineHealth;
    const latency_ms = Date.now() - t0;
    if (body.ari_connected === false) {
      return {
        status: "degraded",
        latency_ms,
        error:
          "engine is running but not attached to Asterisk (ARI) — inbound calls are not answered",
      };
    }
    if (body.audiosocket?.listening === false) {
      return {
        status: "degraded",
        latency_ms,
        error:
          "AudioSocket is not listening — Asterisk has no port to hand the call audio to",
      };
    }
    if (body.default_ready === false || (body.status && body.status !== "healthy")) {
      return {
        status: "degraded",
        latency_ms,
        error: `engine reports ${body.status ?? "not ready"} — its own /health names the cause`,
      };
    }
    // Per-pipeline validity is deliberately NOT judged here: an optional
    // pipeline (the licensed premium voice) is invalid until its key is set on
    // a perfectly healthy install, and calling that a system failure is the
    // false alarm the Stripe probe already had to be rescued from.
    return { status: "ok", latency_ms };
  } catch (e) {
    return {
      status: "degraded",
      latency_ms: Date.now() - t0,
      error: `no voice engine at ${AVA_ENGINE_URL} — calls routed to AVA are not answered (${e instanceof Error ? e.message : String(e)})`,
    };
  }
}

/**
 * Reachability is not usability: on a first run AVA mints a one-time admin
 * password and answers 403 to everything until it is rotated, so the console
 * can be up while the Voice screens read nothing. The authenticated call is
 * what makes that difference visible — and it is the same client the screens
 * use, so this probe cannot pass while they fail.
 */
async function probeAvaAdmin(): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${avaAdminBase()}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) throw new Error(`admin health returned ${res.status}`);
  } catch (e) {
    return {
      status: "down",
      latency_ms: Date.now() - t0,
      error: `AVA admin API not reachable at ${avaAdminBase()} — the Voice screens have no data (${e instanceof Error ? e.message : String(e)})`,
    };
  }

  const latency_ms = Date.now() - t0;
  const agents = await listAgents();
  if (agents.state === "ok") return { status: "ok", latency_ms };
  return { status: "degraded", latency_ms, error: agents.error };
}

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
    freepbx_api: ProbeResult;
    asterisk_ami: ProbeResult;
    stripe: ProbeResult;
    voipms_api: ProbeResult;
    avantfax: ProbeResult;
    ava_engine: ProbeResult;
    ava_admin: ProbeResult;
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
  // ── Run all probes concurrently (avoids sequential timeouts
  //    exceeding the Docker healthcheck timeout when external
  //    services are unreachable). ─────────────────────────────
  // ── The voice plane is `--profile voice`, so it is only probed where it is
  //    configured. Reporting a missing engine as "down" on every portal-only
  //    install is the mistake the Stripe probe already made once: a deliberate
  //    default read as a failure. avaConfigured() is the same switch the Voice
  //    screens use, so the two agree about whether AVA is in play here.
  const voiceExpected = avaConfigured();

  const [dbResult, freepbxResult, amiResult, stripeResult, avantfaxResult, engineResult, adminResult] =
    await Promise.all([
      // ── Database (SQLite) ──────────────────────────────────
      probe("database", async () => {
        const row = db.prepare("SELECT 1 as ok").get() as { ok: number };
        if (row.ok !== 1) throw new Error("Unexpected query result");
      }),

      // ── FreePBX API ────────────────────────────────────────
      probe("freepbx_api", async () => {
        const url = process.env.FREEPBX_URL;
        if (!url) throw new Error("FREEPBX_URL not set");

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5_000);

        try {
          // Simple connectivity check — the OAuth2 token endpoint has a
          // known PHP bug in some FreePBX versions (Undefined array key
          // "framework"), so we just verify the FreePBX web UI responds.
          const res = await fetch(`${url.replace(/\/$/, "")}/admin/`, {
            signal: controller.signal,
          });
          if (!res.ok && res.status >= 500)
            throw new Error(`FreePBX web UI returned ${res.status}`);
        } finally {
          clearTimeout(timeout);
        }
      }),

      // ── Asterisk AMI ───────────────────────────────────────
      probe("asterisk_ami", async () => {
        const ami = getAmiClient();
        const host = process.env.ASTERISK_AMI_HOST;
        if (!host) {
          // AMI not configured — not applicable
          return;
        }

        if (ami.isConnected) {
          // Verify the connection is actually alive with a ping
          const alive = await ami.ping();
          if (!alive) {
            throw new Error("AMI ping failed — connection may be stale");
          }
          return;
        }

        // Not connected — auto-reconnect is handling it, report current state
        throw new Error(
          `AMI not connected to ${host}:${process.env.ASTERISK_AMI_PORT ?? "5038"}`,
        );
      }),

      // ── Stripe (config check only) ─────────────────────────
      // Self-billing is a deprecated mode: this portal's billing runs on
      // Magnate (subscribe.innotel.us), and the checkout route that consumes
      // STRIPE_SECRET_KEY says to leave it empty in exactly that case. Treating
      // that deliberate, documented default as "down" made the whole dashboard
      // read "System Degraded" on a healthy install. An empty key is only a
      // real failure when nothing else owns billing.
      probe("stripe", async () => {
        const key = process.env.STRIPE_SECRET_KEY;
        if (!key) {
          if (process.env.MAGNATE_PUBLIC_URL) return; // delegated — nothing to check here
          throw new Error(
            "STRIPE_SECRET_KEY not set and no billing platform configured",
          );
        }
        // Verify it looks like a valid Stripe secret key
        if (!key.startsWith("sk_") && !key.startsWith("rk_"))
          throw new Error("STRIPE_SECRET_KEY does not match expected format");
        // Optional: verify the webhook secret is set too
        const wh = process.env.STRIPE_WEBHOOK_SECRET;
        if (!wh) throw new Error("STRIPE_WEBHOOK_SECRET not set");
      }),

      // ── AvantFAX ───────────────────────────────────────────
      probe("avantfax", async () => {
        const url = process.env.AVANTFAX_URL || process.env.NEXT_PUBLIC_AVANTFAX_URL;
        if (!url) throw new Error("AVANTFAX_URL not set");

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5_000);
        try {
          // The fax module is served at <url>/ (its login form posts to
          // <url>/index.php). Anything below 500 means the UI is up — the
          // dashboard links straight to this path.
          const res = await fetch(`${url.replace(/\/+$/, "")}/`, {
            signal: controller.signal,
          });
          if (!res.ok && res.status >= 500)
            throw new Error(`AvantFAX returned ${res.status}`);
        } finally {
          clearTimeout(timeout);
        }
      }),

      // ── AVA engine + admin API ─────────────────────────────
      // Position matters: this array is destructured by position below, and a
      // probe inserted in the wrong place reports one service's state under
      // another's name (which is exactly how it looked on the first run).
      voiceExpected ? probeAvaEngine() : Promise.resolve<ProbeResult>({ status: "ok", latency_ms: 0 }),
      voiceExpected ? probeAvaAdmin() : Promise.resolve<ProbeResult>({ status: "ok", latency_ms: 0 }),
    ]);

  // ── VoIP.ms REST API credentials ───────────────────────────
  // Config check, not a network probe: without these two the number
  // provisioning, SMS and CDR routes cannot work at all, so the dashboard's
  // "Connection active" badge was lying. Reported as degraded (never down) so
  // a missing credential surfaces without flipping the whole install's status.
  const voipmsConfigured = Boolean(
    process.env.VOIPMS_API_USERNAME && process.env.VOIPMS_API_PASSWORD,
  );
  const voipmsResult: ProbeResult = voipmsConfigured
    ? { status: "ok", latency_ms: 0 }
    : {
        status: "degraded",
        latency_ms: 0,
        error:
          "VOIPMS_API_USERNAME / VOIPMS_API_PASSWORD not set — buying and managing " +
          "numbers is disabled (VoIP.ms portal → Main Menu → SOAP/REST API)",
      };

  // ── Aggregate status ───────────────────────────────────────
  const services: HealthResponse["services"] = {
    database: dbResult,
    freepbx_api: freepbxResult,
    asterisk_ami: amiResult,
    stripe: stripeResult,
    voipms_api: voipmsResult,
    avantfax: avantfaxResult,
    ava_engine: engineResult,
    ava_admin: adminResult,
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
