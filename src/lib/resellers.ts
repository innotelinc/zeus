import db from "./db";

export interface Reseller {
  id: string;
  name: string;
  brand_name: string | null;
  domain: string | null;
  plan_status: string;
  created_at: string;
}

export function getResellers(): Reseller[] {
  return db
    .prepare("SELECT * FROM resellers ORDER BY name ASC")
    .all() as Reseller[];
}

/** Match a request Host header against the reseller domain map. */
export function findResellerByHost(host: string | null | undefined): Reseller | null {
  if (!host) return null;
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  const resellers = getResellers();
  return (
    resellers.find((r) => {
      const domain = (r.domain ?? "").trim().replace(/^\./, "").toLowerCase();
      if (!domain) return false;
      return hostname === domain || hostname.endsWith(`.${domain}`);
    }) ?? null
  );
}

/** White-label brand for a request host (falls back to env / "Zeus"). */
export function brandNameFor(host: string | null | undefined): string | null {
  return findResellerByHost(host)?.brand_name?.trim() || null;
}