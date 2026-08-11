/**
 * Next.js Instrumentation — runs once at server startup.
 * Starts the Asterisk AMI client and registers event handlers.
 */
export async function register() {
  console.log(">>> instrumentation.ts: register() called");
  if (process.env.NEXT_RUNTIME === "nodejs") {
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
