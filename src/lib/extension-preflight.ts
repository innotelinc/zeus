/**
 * The portal's half of the one provisioning path (D6) — the judgement half.
 *
 * `pbx/provision_extension.py` is the owner of extension/device creation, and
 * the reason it exists is that a *second* writer is the whole defect: two
 * products creating PBX objects by writing tables directly is how
 * `(1,'maxchans')` — a MySQL `1062` on `pjsip`'s primary key — came to break an
 * unrelated feature in a GUI dialog nobody could act on. The portal's Phone
 * screen was that second writer: `POST /api/phone/extensions` called
 * `freepbx.addExtension` and never asked whether the number was safe to create.
 *
 * The portal cannot *run* the Python tool: its image ships `node server.js`
 * with no interpreter and no docker socket, and the tool takes its measurement
 * through `docker exec` into the PBX container. What the portal does have is
 * access to the same *authorities* the tool reads — FreePBX's own API for the
 * extension list, Asterisk's AMI for AstDB, and the mounted `/etc/asterisk` for
 * PJSIP ownership — so this module reproduces the judgement against those
 * answers and refuses with the tool's own vocabulary.
 *
 * Two rules keep the mirror honest, and both are pinned by
 * `scripts/extension-preflight.test.mjs`:
 *
 *   1. **The refusal is the deliverable.** The tool's whole advance over the
 *      old failure is that it *names* the state and the repair instead of
 *      surfacing a raw collision. So the reason and repair strings here are the
 *      same strings, and a test runs the same observed states through both
 *      implementations and compares them.
 *   2. **A blank state is not a green one.** The portal cannot see every fact
 *      the tool reads (it has no SQL against the `users`/`devices` tables), so
 *      what it can establish is named and what it cannot is *refused* rather
 *      than assumed. `ObservedExtensions.modulesOk` is the precedent the tool
 *      already sets: unknown is not "ok".
 *
 * The judgement is pure on purpose — no imports, no I/O — so the decision table
 * is exercised without a PBX (the tool's own `--observed-json` is the same
 * idea from the other end).
 */

/**
 * A FreePBX extension number: digits only. Mirrors `EXT_RE` in
 * `pbx/provision_extension.py` — a *user/device* is an extension you dial, and
 * every consumer on this box assumes digits.
 */
export const EXT_RE = /^[0-9]{2,8}$/;

/** The AstDB family extension state lives under. Mirrors `ASTDB_FAMILY`. */
export const ASTDB_FAMILY = "AMPUSER";

/** One extension the platform intends to exist. Mirrors `Intent`. */
export interface ExtensionIntent {
  extension: string;
  name: string;
}

/**
 * The PBX's state, as the tool measures it. Mirrors `Observed` in
 * `pbx/provision_extension.py`, field for field and name for name, so the two
 * can be compared directly and a measurement can move between them.
 */
export interface ObservedExtensions {
  users: ReadonlySet<string>;
  devices: ReadonlySet<string>;
  sipIds: ReadonlySet<string>;
  pjsipIds: ReadonlySet<string>;
  astdb: ReadonlySet<string>;
  endpointTwoOwner: ReadonlySet<string>;
  modulesOk: boolean;
  modulesNote: string;
}

/** The wire shape of `ObservedExtensions` — snake_case, as the tool emits it. */
export interface ObservedExtensionsJson {
  users: string[];
  devices: string[];
  sip_ids: string[];
  pjsip_ids: string[];
  astdb: string[];
  endpoint_two_owner: string[];
  modules_ok: boolean;
  modules_note: string;
}

function asSet(value: unknown, field: string): Set<string> {
  if (value === undefined || value === null) return new Set();
  if (!Array.isArray(value)) throw new Error(`observed.${field} must be a list`);
  return new Set(value.map((entry) => String(entry)));
}

/** Parse a measurement. Mirrors `Observed.from_dict`. */
export function observedFromJson(raw: Record<string, unknown>): ObservedExtensions {
  return {
    users: asSet(raw.users, "users"),
    devices: asSet(raw.devices, "devices"),
    sipIds: asSet(raw.sip_ids, "sip_ids"),
    pjsipIds: asSet(raw.pjsip_ids, "pjsip_ids"),
    astdb: asSet(raw.astdb, "astdb"),
    endpointTwoOwner: asSet(raw.endpoint_two_owner, "endpoint_two_owner"),
    modulesOk: raw.modules_ok === undefined ? true : Boolean(raw.modules_ok),
    modulesNote: String(raw.modules_note ?? ""),
  };
}

/** Emit a measurement. Mirrors `Observed.to_dict`. */
export function observedToJson(observed: ObservedExtensions): ObservedExtensionsJson {
  const sorted = (values: ReadonlySet<string>) => [...values].sort();
  return {
    users: sorted(observed.users),
    devices: sorted(observed.devices),
    sip_ids: sorted(observed.sipIds),
    pjsip_ids: sorted(observed.pjsipIds),
    astdb: sorted(observed.astdb),
    endpoint_two_owner: sorted(observed.endpointTwoOwner),
    modules_ok: observed.modulesOk,
    modules_note: observed.modulesNote,
  };
}

/**
 * What the judgement decided. `"in-sync"` means the number already exists (the
 * create is a no-op); `"create"` means it is safe to create; `"refuse"` carries
 * the tool's own reason and repair.
 */
export type VerdictState = "in-sync" | "create" | "refuse";

export interface Verdict {
  state: VerdictState;
  reason: string;
  repair: string;
}

function inSync(): Verdict {
  return { state: "in-sync", reason: "", repair: "" };
}

function create(): Verdict {
  return { state: "create", reason: "", repair: "" };
}

function refuse(reason: string, repair: string): Verdict {
  return { state: "refuse", reason, repair };
}

/**
 * Check-then-create for one intent. Mirrors `judge()` in
 * `pbx/provision_extension.py`, including the order — the most specific, most
 * damaging state is named first: a two-owner endpoint (another product's
 * object) before an orphaned technology row, before leftover state, before a
 * half-created extension.
 */
export function judgeExtension(intent: ExtensionIntent, observed: ObservedExtensions): Verdict {
  if (!observed.modulesOk) {
    // Not a per-intent problem: on a PBX whose Core module is not usable,
    // nothing here can be created and re-running changes nothing.
    return refuse(
      observed.modulesNote || "the PBX's Core module is not usable",
      "fix the FreePBX module state (`fwconsole ma list`, then " +
        "`fwconsole ma enable core`), then re-run",
    );
  }

  const { extension: ext } = intent;
  const hasUser = observed.users.has(ext);
  const hasDevice = observed.devices.has(ext);

  if (hasUser && hasDevice) return inSync();

  if (hasUser || hasDevice) {
    return refuse(
      "the PBX has " +
        (hasUser ? "a user object but no device" : "a device but no user object"),
      "finish or delete it in FreePBX (Applications → Extensions) — " +
        "creating here would leave two objects with one id",
    );
  }

  if (observed.endpointTwoOwner.has(ext)) {
    return refuse(
      "the PJSIP endpoint for this extension already has two owners " +
        "(a duplicate object id in the load tree)",
      "settle the endpoint's owner first — `python3 " +
        "pbx/pjsip_owner_check.py --live --extension " +
        ext +
        "` names the two files (docs/ava-capstone-convergence.md §11.5)",
    );
  }

  const orphanTables: string[] = [];
  if (observed.sipIds.has(ext)) orphanTables.push("sip");
  if (observed.pjsipIds.has(ext)) orphanTables.push("pjsip");
  if (orphanTables.length > 0) {
    return refuse(
      `the ${orphanTables.join("/")} table already has a row for this extension ` +
        "while the users/devices tables do not — an orphaned technology row",
      "delete that row first (this is the `(1,'maxchans')` class: " +
        "creating over it collides, or silently shadows it)",
    );
  }

  if (observed.astdb.has(ext)) {
    return refuse(
      `AstDB still holds ${ASTDB_FAMILY}/${ext} state (call forwarding, ` +
        "call waiting or a device mapping from a deleted extension)",
      `clear it in Asterisk (\`database deltree ${ASTDB_FAMILY} ${ext}\`) — ` +
        "a new phone on this number would otherwise inherit it",
    );
  }

  return create();
}

/**
 * The extensions with leftover state under one AstDB family, from the output of
 * `asterisk -rx 'database show <family>'`. Mirrors `parse_astdb` in
 * `pbx/provision_extension.py`: the key is `<ext>/<rest>` for an extension's own
 * subtree, and a key with no `/` is a family-level value, not an extension.
 */
export function parseAstdb(text: string, family: string = ASTDB_FAMILY): Set<string> {
  const found = new Set<string>();
  const prefix = `/${family}/`;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith(prefix)) continue;
    const key = line.slice(prefix.length).split(":", 1)[0].trim();
    const ext = key.split("/", 1)[0].trim();
    if (ext) found.add(ext);
  }
  return found;
}

/** Is this a FreePBX extension number the provisioner would accept? */
export function isValidExtension(extension: string): boolean {
  return EXT_RE.test(extension);
}
