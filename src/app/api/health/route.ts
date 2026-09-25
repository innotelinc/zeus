import { NextResponse } from "next/server";
import db from "@/lib/db";
import { getAmiClient } from "@/lib/ami";
import {
  dograhConfigured,
  getHealth as getDograhHealth,
  getVoiceStack,
  listWorkflows,
  type DograhVoiceStack,
} from "@/lib/dograh";
import { preflightReadiness, preflightReadinessError } from "@/lib/extension-preflight-live";

export const dynamic = "force-dynamic";

/**
 * The voice engine's own verdict.
 *
 * `degraded`, not `down`: the portal can describe the whole estate without
 * Dograh, and a row that takes the install's aggregate status down because the
 * optional voice plane is missing is the false alarm the Stripe probe already
 * had to be rescued from once. What it must never do is report `ok` for an
 * engine it could not reach — an operator staring at a quiet console needs to
 * know whether that is quiet or broken.
 */
async function probeDograhEngine(): Promise<ProbeResult> {
  const t0 = Date.now();
  const health = await getDograhHealth();
  const latency_ms = Date.now() - t0;
  if (health.state === "ok") {
    return {
      status: "ok",
      latency_ms,
      detail: `Dograh ${health.data.version ?? "unknown version"} (${health.data.deployment_mode ?? "unknown mode"})`,
    };
  }
  return {
    status: "degraded",
    latency_ms,
    error: `${health.error} — calls routed to the voice plane are not answered`,
  };
}

/**
 * Whether the console can list agents at all — the authenticated read the
 * Voice screens depend on.
 *
 * Separate from the engine probe because reachability is not usability: a
 * Dograh that answers `/health` and then refuses the service key leaves the
 * screens empty while the process looks perfectly healthy. This is the same
 * client they use, so it cannot pass while they fail.
 */
async function probeDograhAgents(): Promise<ProbeResult> {
  const t0 = Date.now();
  const workflows = await listWorkflows();
  const latency_ms = Date.now() - t0;
  if (workflows.state !== "ok") {
    return { status: "degraded", latency_ms, error: workflows.error };
  }
  const active = workflows.data.filter((workflow) => workflow.status === "active").length;
  return {
    status: "ok",
    latency_ms,
    detail: `${active} active workflow${active === 1 ? "" : "s"} of ${workflows.data.length}`,
  };
}

/**
 * Which STT, TTS and LLM the agents actually run on.
 *
 * Read from the engine rather than from this repo's `.env`, because that is the
 * value in force: a deployment that changed the voice in Dograh's UI and not
 * here would otherwise be described by this screen, wrongly. The deliverable
 * for this estate is local-only speech, so this row is where "is it really
 * running Whisper and Kokoro, or did it silently fall back to a hosted voice?"
 * is answered without opening another product.
 *
 * `degraded`, never `down` — a preference that could not be read must not take
 * a working phone system down.
 */
async function probeDograhVoice(): Promise<ProbeResult> {
  const t0 = Date.now();
  const stack = await getVoiceStack();
  const latency_ms = Date.now() - t0;
  if (stack.state !== "ok") {
    return { status: "degraded", latency_ms, error: stack.error };
  }
  return { status: "ok", latency_ms, detail: describeVoiceStack(stack.data) };
}

/**
 * One line naming the voice that will speak, for a person who has never opened
 * Dograh. Absent halves are named as absent rather than omitted, so a pipeline
 * missing its TTS reads as "no TTS" instead of as a shorter, healthier line.
 */
function describeVoiceStack(stack: DograhVoiceStack): string {
  const part = (label: string, config: DograhVoiceStack["stt"]): string => {
    if (!config) return `${label} not configured`;
    // The voice is the TTS half's own name for *which* voice; it is what makes
    // "kokoro" mean "af_heart" to anyone reading the row.
    const voice = config.voice ? ` (${config.voice})` : "";
    const model = config.model ?? config.provider ?? "unknown";
    const provider = config.provider ? `${config.provider}/` : "";
    return `${label} ${provider}${model}${voice}`;
  };
  const parts = [
    part("STT", stack.stt),
    part("TTS", stack.tts),
    part("LLM", stack.llm),
  ];
  if (stack.is_realtime) parts.push("realtime speech-to-speech");
  return parts.join(" · ");
}

/**
 * Can the phone plane create an extension *safely*?
 *
 * `POST /api/phone/extensions` refuses with a 503 when any of the preflight's
 * three sources (FreePBX's extension list, the AstDB over AMI, the mounted
 * `/etc/asterisk`) cannot be read — correct, but an operator only meets it when
 * they click Add extension. This reports which source is missing from the same
 * place the rest of the voice plane is reported, so the cause is visible before
 * the refusal.
 *
 * `degraded`, never `down`: a box that cannot provision a phone is not a box
 * that cannot answer one — the AST/AMI state that breaks a *create* is exactly
 * the state a live call may not care about. The same reasoning the VoIP.ms
 * config check follows.
 */
async function probeExtensionPreflight(): Promise<ProbeResult> {
  const t0 = Date.now();
  const readiness = await preflightReadiness();
  const latency_ms = Date.now() - t0;
  if (readiness.ok) return { status: "ok", latency_ms };
  return { status: "degraded", latency_ms, error: preflightReadinessError(readiness) };
}



interface ProbeResult {
  status: "ok" | "degraded" | "down";
  latency_ms: number;
  error?: string;
  /**
   * A short factual readout for a probe whose *answer* is data rather than a
   * state — what the engine loaded, not whether it is healthy. Rendered as
   * neutral text beside the status, so a healthy row is not painted as a
   * failure just for having something to say.
   */
  detail?: string;
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
    dograh_engine: ProbeResult;
    dograh_agents: ProbeResult;
    extension_preflight: ProbeResult;
    dograh_voice: ProbeResult;
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
  // ── The voice plane is optional, so it is only probed where it is
  //    configured. Reporting a missing engine as "down" on every portal-only
  //    install is the mistake the Stripe probe already made once: a deliberate
  //    default read as a failure. dograhConfigured() is the same switch the
  //    Voice screens use, so the two agree about whether it is in play here.
  const voiceExpected = dograhConfigured();

  const [dbResult, freepbxResult, amiResult, stripeResult, avantfaxResult, engineResult, adminResult, preflightResult, voiceSettingsResult] =
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

      // ── Dograh: engine, then the authenticated agent read ──
      // Position matters: this array is destructured by position below, and a
      // probe inserted in the wrong place reports one service's state under
      // another's name (which is exactly how it looked on the first run).
      voiceExpected ? probeDograhEngine() : Promise.resolve<ProbeResult>({ status: "ok", latency_ms: 0 }),
      voiceExpected ? probeDograhAgents() : Promise.resolve<ProbeResult>({ status: "ok", latency_ms: 0 }),

      // ── Extension provisioning readiness ──────────────────
      // Placed after the voice probes on purpose: this array is destructured
      // by position (see the note there) — appending at the end shifts nothing.
      probeExtensionPreflight(),

      // ── The voice stack the agents actually run on ────────
      // Last, for the same position reason as above.
      voiceExpected
        ? probeDograhVoice()
        : Promise.resolve<ProbeResult>({
            status: "ok",
            latency_ms: 0,
            detail: "voice engine not configured on this deployment",
          }),
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
    dograh_engine: engineResult,
    dograh_agents: adminResult,
    extension_preflight: preflightResult,
    dograh_voice: voiceSettingsResult,
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
