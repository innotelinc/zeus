/**
 * Next.js Instrumentation — runs once at server startup.
 * Starts the Asterisk AMI client and registers event handlers.
 *
 * It also starts the OTLP tracer (src/lib/otel.ts) — the portal's half of the
 * estate's one trace spine. Traces are a no-op until OTEL_EXPORTER_OTLP_ENDPOINT
 * is set, so this call is inert on a portal-only install and on the test suite;
 * when it *is* set it is the same endpoint Capstone exports to (see
 * docs/stack.md, and compose.observability.yml for the external-collector mode).
 */
export async function register() {
  console.log(">>> instrumentation.ts: register() called");
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startOtel } = await import("@/lib/otel");
    startOtel();

    // The Voice screens are gated on a credential this process may not hold:
    // compose reads env_file at container *create* time, so a portal created
    // before AVA_ADMIN_PASSWORD reached .env renders "not configured" with
    // nothing anywhere saying what to do about it. One line at boot is the
    // cheapest place to say it (docs/ava-runbook.md §7).
    const { avaConfigurationWarning } = await import("@/lib/ava");
    const voiceWarning = avaConfigurationWarning();
    if (voiceWarning) console.warn("AVA:", voiceWarning);

    console.log(">>> instrumentation: starting AMI...");
    const { startAmi } = await import("@/lib/ami");
    const { initAmiHandler } = await import("@/lib/ami-handler");

    initAmiHandler();

    startAmi().then(async (client) => {
      if (client.isConnected) {
        console.log("AMI: Client started and event handlers registered");
        // Refresh all extension states now that we're connected
        const { refreshAllExtensionStates } = await import("@/lib/ami-handler");
        refreshAllExtensionStates(client).catch((e: Error) =>
          console.warn("AMI: Failed to refresh extension states:", e.message),
        );
      } else {
        console.warn("AMI: Client initialized but not connected — check credentials / network");
      }
    }).catch((err: Error) => {
      console.error("AMI: Unexpected error during startup:", err.message);
    });
  }
}
