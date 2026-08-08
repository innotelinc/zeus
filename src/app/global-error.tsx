"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "16px",
            padding: "24px",
            fontFamily:
              "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
            textAlign: "center",
            background: "#0a0f1c",
            color: "#fff",
          }}
        >
          <p
            style={{
              fontSize: "12px",
              fontWeight: 600,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "#38bdf8",
              margin: 0,
            }}
          >
            Something went wrong
          </p>
          <h1 style={{ fontSize: "24px", margin: 0 }}>
            This page couldn&apos;t load
          </h1>
          <p style={{ color: "rgba(255,255,255,0.6)", margin: 0 }}>
            {error?.digest ? `Error code: ${error.digest}` : "An unexpected error occurred."}
          </p>
          <button
            onClick={reset}
            style={{
              marginTop: "8px",
              padding: "10px 20px",
              borderRadius: "8px",
              border: "none",
              background: "#38bdf8",
              color: "#08111f",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
