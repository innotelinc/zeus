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

    startAmi().then(() => {
      console.log("AMI: Client started and event handlers registered");
    }).catch((err: Error) => {
      console.warn("AMI: Could not start client:", err.message);
    });
  }
}
