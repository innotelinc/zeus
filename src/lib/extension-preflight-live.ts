/**
 * Reading the PBX for the provisioning preflight, from the portal's vantage.
 *
 * `src/lib/extension-preflight.ts` is the judgement (pure and pinned);
 * this module is the measurement it is judged against, gathered from the three
 * authorities the portal can actually reach:
 *
 *   * **FreePBX's own API** (`fetchAllExtensions`) for what extensions exist;
 *   * **Asterisk's AMI** (`database show AMPUSER`) for leftover AstDB state;
 *   * **the mounted `/etc/asterisk`** for PJSIP endpoint ownership.
 *
 * The tool it mirrors (`pbx/provision_extension.py`) reads the raw `users`,
 * `devices`, `sip` and `pjsip` tables through `docker exec`; the portal cannot.
 * Two honest consequences, both named rather than hidden:
 *
 *   * An extension FreePBX's API returns is a complete user **and** device, so
 *     the mirror cannot observe the half-created state (user without device) by
 *     itself — it can only see it when the technology rows disagree.
 *   * `sipIds` is always empty: the portal reads no `sip.conf`. The orphaned
 *     *pjsip* endpoint (an endpoint in the load tree that FreePBX's list does not
 *     name) is observable and is what the `(1,'maxchans')` class actually was.
 *
 * **A source that cannot be read is not an empty one.** Every failure here
 * returns `ok: false` so the caller refuses, because "I could not check" must
 * never be acted on as "there is nothing there" — which is the difference
 * between a named refusal and a create that collides.
 */
import { existsSync } from "node:fs";
import { getAmiClient } from "./ami";
import { fetchAllExtensions } from "./freepbx";
import { DEFAULT_CONF_DIR, definitions, parseSections, readConfDir } from "./pjsip-owners";
import { ASTDB_FAMILY, parseAstdb, type ObservedExtensions } from "./extension-preflight";

export interface PreflightReadOk {
  ok: true;
  observed: ObservedExtensions;
}

export interface PreflightReadUnavailable {
  ok: false;
  reason: string;
}

export type PreflightRead = PreflightReadOk | PreflightReadUnavailable;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * One of the three authorities the preflight reads, and whether it answered.
 * `detail` names what is wrong *and* what restores it — the same half of the
 * refusal the create route prints, so the readiness screen and the refusal
 * agree about the repair.
 */
export interface PreflightSource {
  source: "freepbx_api" | "asterisk_ami" | "asterisk_config";
  ok: boolean;
  detail: string;
}

export interface PreflightReadiness {
  /** Every source answered — a create can be judged. */
  ok: boolean;
  sources: PreflightSource[];
}

/** The repair common to every unreadable source, phrased once. */
const SOURCE_REPAIR =
  "restore the missing source (AMI credentials, the Asterisk config mount, or " +
  "FreePBX's API) — or run the PBX-side preflight on the voice host: " +
  "`python3 pbx/provision_extension.py --intent <intent.json> --check`";

/**
 * Whether each of the preflight's three sources can be read right now.
 *
 * `POST /api/phone/extensions` refuses with a 503 when any source is
 * unreadable, and that refusal is correct but late: an operator finds out only
 * when they try to add a phone. This probes the same three reads the create path
 * performs — FreePBX's extension list, the AstDB over AMI, and the mounted
 * `/etc/asterisk` — and names which one is missing, so `/api/health` and the
 * Phone screen can say it before anyone clicks. Each source is probed
 * independently: a first failure must not hide the state of the other two.
 *
 * Read-only. It creates nothing and changes no config; it is safe to run on
 * every health request.
 */
export async function preflightReadiness(dir: string = DEFAULT_CONF_DIR): Promise<PreflightReadiness> {
  const sources: PreflightSource[] = [];

  // 1. FreePBX's own answer to "what extensions exist".
  try {
    await fetchAllExtensions();
    sources.push({ source: "freepbx_api", ok: true, detail: "" });
  } catch (e) {
    sources.push({
      source: "freepbx_api",
      ok: false,
      detail: `could not read FreePBX's extension list (${message(e)}) — ${SOURCE_REPAIR}`,
    });
  }

  // 2. Asterisk's own answer, over AMI: does a `Command` complete with output?
  const ami = getAmiClient();
  if (!ami.isConnected) {
    sources.push({
      source: "asterisk_ami",
      ok: false,
      detail: `AMI is not connected, so leftover extension state could not be read — ${SOURCE_REPAIR}`,
    });
  } else {
    try {
      const response = await ami.sendAction({
        Action: "Command",
        Command: `database show ${ASTDB_FAMILY}`,
      });
      sources.push(
        response.Output === undefined
          ? {
              source: "asterisk_ami",
              ok: false,
              detail:
                "`database show` answered without output — this client cannot tell whether " +
                `AMPUSER state exists — ${SOURCE_REPAIR}`,
            }
          : { source: "asterisk_ami", ok: true, detail: "" },
      );
    } catch (e) {
      sources.push({
        source: "asterisk_ami",
        ok: false,
        detail: `the AstDB read failed (${message(e)}) — ${SOURCE_REPAIR}`,
      });
    }
  }

  // 3. The mounted config, for endpoint ownership.
  sources.push(
    existsSync(dir)
      ? { source: "asterisk_config", ok: true, detail: "" }
      : {
          source: "asterisk_config",
          ok: false,
          detail: `the Asterisk config directory ${dir} is not mounted, so endpoint ownership could not be read — ${SOURCE_REPAIR}`,
        },
  );

  return { ok: sources.every((s) => s.ok), sources };
}

/**
 * One line for a health probe: which sources could not be read, why, and the
 * repair. The shared repair is stated once at the end rather than repeated per
 * source, and each source keeps its specific cause (an unset `FREEPBX_URL`, a
 * missing mount) — a readiness check that only said "preflight unavailable"
 * would be the same unactionable dialog the preflight exists to replace.
 */
export function preflightReadinessError(readiness: PreflightReadiness): string {
  const reasons = readiness.sources
    .filter((s) => !s.ok)
    .map((s) => s.detail.replace(` — ${SOURCE_REPAIR}`, ""));
  return `adding an extension would be refused: ${reasons.join("; ")} — ${SOURCE_REPAIR}`;
}

/**
 * Measure the PBX for one extension. `ok: false` means the caller must refuse
 * — the PBX could not be read, so nothing here is safe to create over.
 */
export async function readObservedExtensions(
  extension: string,
  dir: string = DEFAULT_CONF_DIR,
): Promise<PreflightRead> {
  // 1. The extension list — FreePBX's own answer to "what exists".
  let extensionIds: Set<string>;
  try {
    extensionIds = new Set((await fetchAllExtensions()).map((row) => row.extensionId));
  } catch (e) {
    return {
      ok: false,
      reason: `could not read FreePBX's extension list (${message(e)})`,
    };
  }

  // 2. AstDB — Asterisk's own answer, over AMI.
  const ami = getAmiClient();
  if (!ami.isConnected) {
    return { ok: false, reason: "AMI is not connected, so leftover extension state could not be read" };
  }
  let output: string | undefined;
  try {
    const response = await ami.sendAction({
      Action: "Command",
      Command: `database show ${ASTDB_FAMILY}`,
    });
    output = response.Output;
  } catch (e) {
    return { ok: false, reason: `the AstDB read failed (${message(e)})` };
  }
  if (output === undefined) {
    // `database show` always sends an `Output` field, empty for "no entries".
    // Its absence is a framing fault, and reading it as "no state" would let a
    // new phone inherit the previous one's call forwarding.
    return {
      ok: false,
      reason: "`database show` answered without output — this client cannot tell whether AMPUSER state exists",
    };
  }

  // 3. Endpoint ownership — the mounted config, with the tool's own parsing.
  if (!existsSync(dir)) {
    return {
      ok: false,
      reason: `the Asterisk config directory ${dir} is not mounted, so endpoint ownership could not be read`,
    };
  }
  const files = new Map<string, ReturnType<typeof parseSections>>();
  for (const [name, text] of readConfDir(dir)) files.set(name, parseSections(text));

  const endpointTwoOwner = new Set<string>();
  const pjsipIds = new Set<string>();
  for (const places of definitions(files).values()) {
    const [first] = places;
    if (!first || first.type !== "endpoint") continue;
    if (places.length > 1 && first.id === extension) endpointTwoOwner.add(first.id);
    // An endpoint in the load tree that FreePBX's own list does not name is a
    // technology row without a user/device — the orphan this preflight refuses.
    if (places.length <= 1 && !extensionIds.has(first.id)) pjsipIds.add(first.id);
  }

  return {
    ok: true,
    observed: {
      // The API lists complete extensions, so user and device are one fact from
      // it. Kept as two sets to mirror the tool and so a future read path can
      // separate them without changing the judgement.
      users: extensionIds,
      devices: extensionIds,
      sipIds: new Set(),
      pjsipIds,
      astdb: parseAstdb(output),
      endpointTwoOwner,
      // The API answering at all is the Core module working; there is nothing
      // else to report and nothing to warn about.
      modulesOk: true,
      modulesNote: "",
    },
  };
}
