/**
 * The health probe vocabulary — the one place a service's name, description and
 * owning product are declared.
 *
 * `/api/health` returns the probe results; this module is how a screen reads
 * them. It exists so the Health page and the Operations module cannot disagree
 * about what `extension_preflight` is called, which product it belongs to, or
 * what "degraded" means — the estate's one-author rule applied to the machine's
 * own inventory.
 */
import type { ConsoleProduct } from "./console";

export type ProbeStatus = "ok" | "degraded" | "down";

/** One dependency's answer. */
export interface ProbeResult {
  status: ProbeStatus;
  latency_ms: number;
  error?: string;
  /** A factual readout for a probe whose answer is data, not a state. */
  detail?: string;
}

export const SERVICE_KEYS = [
  "database",
  "freepbx_api",
  "asterisk_ami",
  "stripe",
  "voipms_api",
  "avantfax",
  "dograh_engine",
  "dograh_agents",
  "extension_preflight",
  "softphone_media",
  "dograh_voice",
] as const;

export type ServiceKey = (typeof SERVICE_KEYS)[number];

/** The shape `/api/health` serves. */
export interface HealthResponse {
  status: ProbeStatus;
  uptime_seconds: number;
  timestamp: string;
  services: Record<ServiceKey, ProbeResult>;
}

export interface ServiceMeta {
  label: string;
  desc: string;
  icon: string;
  /** Which product owns this dependency — the console's own product ids. */
  product: ConsoleProduct;
}

export const SERVICE_META: Record<ServiceKey, ServiceMeta> = {
  database: {
    label: "Database",
    desc: "SQLite connection and query health",
    icon: "🗄️",
    product: "zeus",
  },
  freepbx_api: {
    label: "FreePBX",
    desc: "PBX web UI connectivity",
    icon: "📡",
    product: "freepbx",
  },
  asterisk_ami: {
    label: "Asterisk AMI",
    desc: "Manager interface for call control",
    icon: "🔌",
    product: "asterisk",
  },
  stripe: {
    label: "Stripe",
    desc: "Billing & subscription config",
    icon: "💳",
    product: "zeus",
  },
  voipms_api: {
    label: "VoIP.ms API",
    desc: "Number provisioning, SMS and CDRs",
    icon: "☎️",
    product: "zeus",
  },
  avantfax: {
    label: "AvantFAX",
    desc: "Fax module web UI",
    icon: "📠",
    product: "avantfax",
  },
  dograh_engine: {
    label: "Voice engine",
    desc: "Dograh itself — the process that answers and runs the call",
    icon: "🤖",
    product: "dograh",
  },
  dograh_agents: {
    label: "Voice agents",
    desc: "The authenticated workflow read behind the Voice screens",
    icon: "🎛️",
    product: "dograh",
  },
  extension_preflight: {
    label: "Extension provisioning",
    desc: "FreePBX API, AMI and the Asterisk config mount the create gate reads",
    icon: "🧾",
    product: "freepbx",
  },
  softphone_media: {
    label: "Softphone media address",
    desc: "The address a softphone created now is handed, before the next boot",
    icon: "🔊",
    product: "freepbx",
  },
  dograh_voice: {
    label: "The voice on the line",
    desc: "Which STT, TTS and LLM the agents actually run on",
    icon: "🎚️",
    product: "dograh",
  },
};

/** The human word for a probe state, used identically on every screen. */
export function statusLabel(status: string): string {
  return status === "ok" ? "Healthy" : status === "degraded" ? "Degraded" : "Unhealthy";
}

/** The Tailwind text colour for a probe state. */
export function statusTextClass(status: string): string {
  return status === "ok"
    ? "text-mint-400"
    : status === "degraded"
      ? "text-amber-400"
      : "text-rose-400";
}
