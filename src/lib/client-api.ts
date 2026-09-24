export class ApiError extends Error {
  status: number;
  /**
   * The parsed error body, when the route sent one.
   *
   * Carried because some refusals are structured on purpose: the extension
   * preflight answers `{ error, reason, repair }`, and a toast that shows only
   * the machine `error` code tells the operator nothing actionable — which is
   * the `(1,'maxchans')` failure this refusal exists to replace.
   */
  body: Record<string, unknown>;
  constructor(message: string, status: number, body: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      (data as { error?: string })?.error ?? "Request failed",
      res.status,
      (data ?? {}) as Record<string, unknown>,
    );
  }
  return data as T;
}

/**
 * The human sentence for a failed call: the route's `reason` and `repair` when
 * it sent them, else the message. One place, so every screen that can meet a
 * structured refusal says the same thing about it.
 */
export function apiErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const reason = typeof e.body.reason === "string" ? e.body.reason : "";
    const repair = typeof e.body.repair === "string" ? e.body.repair : "";
    if (reason) return repair ? `${reason} — ${repair}` : reason;
  }
  return e instanceof Error ? e.message : fallback;
}

export const fmtDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";

export const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

export const fmtDuration = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
};

export const planLabel = (plan: string) =>
  plan === "business" ? "Business" : "Consumer";

export const planPrice = (plan: string) =>
  plan === "business" ? "$49.99/mo" : "$19.99/mo";
