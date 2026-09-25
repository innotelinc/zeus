/**
 * The console map — every screen in the estate, what owns it, and what it is
 * for.
 *
 * The estate is five products with five UIs: Asterisk (no UI), FreePBX (PBX
 * admin), AvantFax (fax), Dograh (voice agents and interview flows), the
 * Capstone dashboard (estate administration), and this portal (the customer's
 * own phone system). An operator doing one job — "why did this number not
 * answer?" — used to have to know which of them held the answer, and the
 * answer was usually *all of them*.
 *
 * This module is the fix: one list, one grouping, one vocabulary for
 * "owned here" versus "lives in another product". The navigation is rendered
 * from it (`DashboardShell`), the console map page is rendered from it
 * (`/dashboard/estate`), and nothing declares a screen anywhere else. Adding a
 * screen means adding a row here, which is what keeps the rail and the map
 * from disagreeing.
 *
 * ## The two kinds of surface
 *
 * - **owned** — this repo builds it. It is a route under `/dashboard`.
 * - **proxied** — a real deployment that stays its own app because rewriting
 *   it would be years of work for no operator benefit. It is reached by a URL
 *   under the estate's own zone, SSO'd by the same gateway, and it is
 *   **labelled** everywhere it appears, so an operator is never unsure which
 *   product they are looking at.
 *
 * A proxied surface is a deliberate debt. It is recorded as one instead of
 * being hidden behind a screen that pretends to own it.
 *
 * See docs/unified-console.md for the design and the migration order.
 */

/** Which product actually answers a screen. */
export type ConsoleProduct =
  | "zeus"
  | "asterisk"
  | "freepbx"
  | "avantfax"
  | "dograh"
  | "capstone";

export interface ConsoleProductInfo {
  id: ConsoleProduct;
  name: string;
  /** What this product is for, in one line, for the console map. */
  role: string;
  stack: string;
  /** What this console does with it: builds it, or points at it. */
  relationship: "owns" | "proxies" | "reads";
}

/**
 * The products, and the honest statement of what this console does with each.
 *
 * `asterisk` is listed even though it has no UI: it is the thing that answers
 * the call, and a map that omits it explains the other five badly.
 */
export const CONSOLE_PRODUCTS: ConsoleProductInfo[] = [
  {
    id: "zeus",
    name: "Zeus portal",
    role: "The customer's own phone system, and the frame every other screen sits in.",
    stack: "Next.js, this repo",
    relationship: "owns",
  },
  {
    id: "asterisk",
    name: "Asterisk",
    role: "The switch. It answers, bridges and records every call.",
    stack: "C, no UI",
    relationship: "owns",
  },
  {
    id: "freepbx",
    name: "FreePBX",
    role: "Administration of Asterisk: trunks, routes, extensions, Module Admin.",
    stack: "PHP",
    relationship: "proxies",
  },
  {
    id: "avantfax",
    name: "AvantFax",
    role: "Fax: send, receive, and the fax archive.",
    stack: "PHP (runs inside the PBX host)",
    relationship: "proxies",
  },
  {
    id: "dograh",
    name: "Dograh",
    role: "The voice agents: interview flows, workflows, transcripts, recordings.",
    stack: "FastAPI + Next.js",
    relationship: "reads",
  },
  {
    id: "capstone",
    name: "Capstone dashboard",
    role: "Estate administration: agents, workflows, runs, grading.",
    stack: "Next.js + FastAPI",
    relationship: "proxies",
  },
];

/**
 * A group is a question, not a product.
 *
 * This is the whole point: an operator looks for "what is happening right now"
 * or "how is a call handled", never for "which of the five holds this".
 */
export type ConsoleGroup =
  | "today"
  | "calls"
  | "inbox"
  | "account"
  | "estate"
  | "admin";

export interface ConsoleGroupInfo {
  id: ConsoleGroup;
  label: string;
  /** The question this group answers — shown as the map's section heading. */
  answers: string;
}

export const CONSOLE_GROUPS: ConsoleGroupInfo[] = [
  { id: "today", label: "Today", answers: "What is happening right now" },
  { id: "calls", label: "Calls", answers: "How a call is handled" },
  { id: "inbox", label: "Inbox", answers: "What arrived and needs a person" },
  { id: "account", label: "Account", answers: "What the customer owns" },
  { id: "estate", label: "Estate", answers: "How the machine is doing" },
  { id: "admin", label: "Admin", answers: "Who has what" },
];

export interface ConsoleSurface {
  id: string;
  label: string;
  group: ConsoleGroup;
  product: ConsoleProduct;
  kind: "owned" | "proxied";
  /** One line, in the operator's words: the question this screen answers. */
  answers: string;
  /** In-console route for owned surfaces. */
  href?: string;
  /** Env var holding the browsable base URL, for proxied surfaces. */
  baseEnv?: string;
  /** Used when `baseEnv` is unset — never a port only this host can reach. */
  baseDefault?: string;
  /** Path appended to the base, e.g. `/fax`. */
  path?: string;
  /** Only shown when this add-on is enabled. */
  addon?: "agents" | "capstone";
  /** Shown only to staff. */
  adminOnly?: boolean;
}

/**
 * Every screen, in the order the rail shows them.
 *
 * A proxied entry's `baseDefault` is deliberately a **public** hostname and not
 * `127.0.0.1:<port>`: the link is followed by a browser, which cannot reach
 * this host's loopback. Links that only this server should use belong in
 * `lib/dograh.ts` / `lib/freepbx.ts`, not here.
 */
export const CONSOLE_SURFACES: ConsoleSurface[] = [
  // ── Today ─────────────────────────────────────────────────────────
  {
    id: "numbers",
    label: "Phone Numbers",
    group: "today",
    product: "zeus",
    kind: "owned",
    answers: "The numbers on this account, and what answers each one",
    href: "/dashboard",
  },
  {
    id: "history",
    label: "Call History",
    group: "today",
    product: "zeus",
    kind: "owned",
    answers: "Every call the switch saw, with its path and account",
    href: "/dashboard/history",
  },
  {
    id: "live-pbx",
    label: "PBX status",
    group: "today",
    product: "freepbx",
    kind: "proxied",
    answers: "Asterisk's own view: channels, registrations, reload state",
    baseEnv: "FREEPBX_ADMIN_URL",
    baseDefault: "https://pbx.zeus.innotel.us",
    path: "/admin",
  },

  // ── Calls ─────────────────────────────────────────────────────────
  {
    id: "voice",
    label: "Voice Agents",
    group: "calls",
    product: "dograh",
    kind: "owned",
    answers: "Which agent answers which number, and how it is set up",
    href: "/dashboard/voice",
    addon: "agents",
  },
  {
    id: "interviews",
    label: "Interviews",
    group: "calls",
    product: "capstone",
    kind: "owned",
    answers: "Which interview workflow each line reaches",
    href: "/dashboard/capstone",
    addon: "capstone",
  },
  {
    id: "workflows",
    label: "Workflows & Flows",
    group: "calls",
    product: "dograh",
    kind: "proxied",
    answers: "Build and edit an agent's flow — prompts, nodes, branching",
    baseEnv: "DOGRAH_UI_URL",
    baseDefault: "https://dograh.capstone.innotel.us",
  },
  {
    id: "workflow-studio",
    label: "Workflow Studio",
    group: "calls",
    product: "capstone",
    kind: "proxied",
    answers: "Visual builder for phone agents outside the main UI",
    baseEnv: "WORKFLOW_STUDIO_URL",
    baseDefault: "https://workflow.capstone.innotel.us",
  },

  // ── Inbox ─────────────────────────────────────────────────────────
  {
    id: "voicemail",
    label: "Voicemail",
    group: "inbox",
    product: "zeus",
    kind: "owned",
    answers: "Messages that arrived and need a person",
    href: "/dashboard/voicemail",
  },
  {
    id: "fax",
    label: "Fax",
    group: "inbox",
    product: "zeus",
    kind: "owned",
    answers: "Send a fax, and read what came in",
    href: "/dashboard/fax",
  },
  {
    id: "fax-archive",
    label: "Fax archive",
    group: "inbox",
    product: "avantfax",
    kind: "proxied",
    answers: "AvantFax's own archive: covers, resolutions, resend",
    baseEnv: "NEXT_PUBLIC_AVANTFAX_URL",
    baseDefault: "https://pbx.zeus.innotel.us/fax",
  },
  {
    id: "messages",
    label: "Messages",
    group: "inbox",
    product: "zeus",
    kind: "owned",
    answers: "SMS threads with this account's contacts",
    href: "/dashboard/messages",
  },

  // ── Account ───────────────────────────────────────────────────────
  {
    id: "contacts",
    label: "Contacts",
    group: "account",
    product: "zeus",
    kind: "owned",
    answers: "Who this account calls, and what they are",
    href: "/dashboard/contacts",
  },
  {
    id: "billing",
    label: "Billing",
    group: "account",
    product: "zeus",
    kind: "owned",
    answers: "The plan, its price, and what it unlocks",
    href: "/dashboard/billing",
  },
  {
    id: "settings",
    label: "Settings",
    group: "account",
    product: "zeus",
    kind: "owned",
    answers: "This account's own configuration, including the softphone",
    href: "/dashboard/settings",
  },

  // ── Estate ────────────────────────────────────────────────────────
  {
    id: "estate",
    label: "System Map",
    group: "estate",
    product: "zeus",
    kind: "owned",
    answers: "What this estate is made of, and which product owns each fact",
    href: "/dashboard/estate",
  },
  {
    id: "health",
    label: "Health",
    group: "estate",
    product: "zeus",
    kind: "owned",
    answers: "Every dependency, probed, with what each failure would look like",
    href: "/dashboard/health",
  },
  {
    id: "pbx-admin",
    label: "FreePBX Admin",
    group: "estate",
    product: "freepbx",
    kind: "proxied",
    answers: "Trunks, outbound routes, extensions, Module Admin",
    baseEnv: "FREEPBX_ADMIN_URL",
    baseDefault: "https://pbx.zeus.innotel.us",
    path: "/admin",
  },
  {
    id: "capstone-dashboard",
    label: "Capstone Dashboard",
    group: "estate",
    product: "capstone",
    kind: "proxied",
    answers: "Estate-wide runs, grading and operational review",
    baseEnv: "CAPSTONE_DASHBOARD_URL",
    baseDefault: "https://dashboard.capstone.innotel.us",
  },

  // ── Admin (staff) ─────────────────────────────────────────────────
  {
    id: "admin",
    label: "Admin",
    group: "admin",
    product: "zeus",
    kind: "owned",
    answers: "Users, plans, resellers, and the per-number voice plan",
    href: "/dashboard/admin",
    adminOnly: true,
  },
];

/**
 * Where a proxied surface lives for a **browser**.
 *
 * Read from the environment at call time so a dev deployment can point at its
 * own host without a rebuild, and falls back to the estate's public hostname
 * rather than a loopback port: a link the operator cannot open is worse than a
 * link that is wrong in a way they can see.
 */
export function proxiedUrl(surface: ConsoleSurface): string | null {
  if (surface.kind !== "proxied") return null;
  const raw = surface.baseEnv ? process.env[surface.baseEnv] : undefined;
  const base = (raw && raw.trim()) || surface.baseDefault || "";
  if (!base) return null;
  const trimmed = base.replace(/\/+$/, "");
  return `${trimmed}${surface.path ?? ""}`;
}

/** The same address, for a screen that has to show it rather than link it. */
export function proxiedHost(surface: ConsoleSurface): string | null {
  const url = proxiedUrl(surface);
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Surfaces visible to this viewer, in rail order, grouped. */
export function visibleSurfaces(options: {
  isAdmin: boolean;
  addons?: Partial<Record<"agents" | "capstone", string>>;
}): ConsoleSurface[] {
  return CONSOLE_SURFACES.filter((surface) => {
    if (surface.adminOnly && !options.isAdmin) return false;
    if (!surface.addon) return true;
    return options.addons?.[surface.addon] === "enabled";
  });
}

/** The group list, each with its visible surfaces, skipping empty groups. */
export function groupedSurfaces(options: {
  isAdmin: boolean;
  addons?: Partial<Record<"agents" | "capstone", string>>;
}): Array<ConsoleGroupInfo & { surfaces: ConsoleSurface[] }> {
  const visible = visibleSurfaces(options);
  return CONSOLE_GROUPS.map((group) => ({
    ...group,
    surfaces: visible.filter((surface) => surface.group === group.id),
  })).filter((group) => group.surfaces.length > 0);
}
