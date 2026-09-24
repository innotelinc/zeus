/**
 * Which file owns a PJSIP endpoint — the portal's mirror of the parser in
 * `pbx/pjsip_owner_check.py`.
 *
 * The provisioner's preflight refuses to create over an extension whose PJSIP
 * endpoint already has **two owners**: the same `(id, type)` defined in more
 * than one file is the duplicate object id that makes sorcery refuse a whole
 * config file, and `pbx/README.md` documents what that cost the last time it
 * happened (`ari.conf`, one duplicate, every ARI user gone).
 *
 * The portal only needs that one answer, but it must be the *same* answer the
 * Python tool gives, or the two halves of "one provisioning path" would disagree
 * about the state of the box. So the parsing rules are the same rules:
 *
 *   * a section header is `[id]`, `[id](base)` or `[id](!)` (`!` = a template,
 *     not an object), and a `;` comment tail is ignored;
 *   * a section's `type` is its explicit `type =` line, else followed one hop
 *     through the template it names — the portal's own `[<ext>](webrtc-template)`
 *     is only an endpoint because of that hop;
 *   * an id is only in conflict when the entries share the **same type** —
 *     `[101]` in `pjsip.endpoint.conf`, `pjsip.auth.conf` and `pjsip.aor.conf`
 *     is three objects, and correctly benign.
 *
 * `scripts/extension-preflight.test.mjs` runs the same fixtures through this
 * module and the Python tool and compares the verdicts, because a comment
 * claiming parity is not parity.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Where Asterisk's config lives, as the portal container sees it. */
export const DEFAULT_CONF_DIR = "/etc/asterisk";

const SECTION_RE = /^\s*\[([^\]]+)\]\s*(?:\(([^)]*)\))?\s*(?:;.*)?$/;
const TYPE_RE = /^\s*type\s*=\s*(\S+)/;

export interface Section {
  id: string;
  /** `[101](webrtc-template)` → "webrtc-template"; absent when there is no tail. */
  base: string | null;
  /** `[x](!)` — a template, not an object. */
  template: boolean;
  /** An explicit `type =` inside the section, first one winning. */
  type: string | null;
}

/** Sections of one config file, in order. Mirrors `parse_config`. */
export function parseSections(text: string): Section[] {
  const sections: Section[] = [];
  for (const line of text.split("\n")) {
    const header = SECTION_RE.exec(line);
    if (header) {
      const base = header[2] ?? null;
      sections.push({ id: header[1].trim(), base, template: base === "!", type: null });
      continue;
    }
    if (sections.length === 0) continue;
    const found = TYPE_RE.exec(line);
    // The first `type` wins: a second one in the same body is a malformed
    // section, not a second object, and taking the last would let a duplicate
    // hide behind it.
    if (found && sections[sections.length - 1].type === null) {
      sections[sections.length - 1].type = found[1];
    }
  }
  return sections;
}

/**
 * The type a section ends up as, following one template hop.
 * Mirrors `object_type` in `pbx/pjsip_owner_check.py`.
 */
export function objectType(section: Section, templates: Map<string, Section>): string | null {
  const seen = new Set<string>();
  let current: Section | null = section;
  while (current) {
    if (current.type !== null) return current.type;
    const base: string | null = current.base;
    if (base === null || base === "!" || seen.has(base)) return null;
    seen.add(base);
    current = templates.get(base) ?? null;
  }
  return null;
}

/** Every template (`[x](!)`) by id, first definition winning. Mirrors `templates_of`. */
export function templatesOf(files: Map<string, Section[]>): Map<string, Section> {
  const found = new Map<string, Section>();
  for (const name of [...files.keys()].sort()) {
    for (const section of files.get(name) ?? []) {
      if (section.template && !found.has(section.id)) found.set(section.id, section);
    }
  }
  return found;
}

/**
 * `(id, type)` → the files that define it. Mirrors `definitions()`: an id whose
 * type cannot be resolved is still listed (as `"?"`), but it cannot be compared
 * with a typed object.
 */
export function definitions(files: Map<string, Section[]>): Map<string, Array<{ file: string; id: string; type: string }>> {
  const templates = templatesOf(files);
  const found = new Map<string, Array<{ file: string; id: string; type: string }>>();
  for (const name of [...files.keys()].sort()) {
    for (const section of files.get(name) ?? []) {
      if (section.template) continue;
      const type = objectType(section, templates) ?? "?";
      const key = `${section.id}\u0000${type}`;
      const list = found.get(key) ?? [];
      list.push({ file: name, id: section.id, type });
      found.set(key, list);
    }
  }
  return found;
}

/** Read every `*.conf` in a directory as `{name: text}`. Missing dir → empty. */
export function readConfDir(dir = DEFAULT_CONF_DIR): Map<string, string> {
  const raw = new Map<string, string>();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return raw;
  }
  for (const name of entries) {
    if (!name.endsWith(".conf")) continue;
    try {
      raw.set(name, readFileSync(join(dir, name), "utf8"));
    } catch {
      // An unreadable file is not evidence of ownership either way; skip it
      // rather than guess. The Python tool reports unreadable files; the portal
      // is not the authority and only needs the duplicate answer.
    }
  }
  return raw;
}

/**
 * Extensions whose PJSIP endpoint is defined as `type = endpoint` in more than
 * one file — the two-owner state. Mirrors `read_endpoint_two_owner`.
 *
 * `wanted` narrows the answer to the extensions being judged; omitted, every
 * conflicted id is returned.
 */
export function endpointTwoOwner(dir = DEFAULT_CONF_DIR, wanted?: ReadonlySet<string>): Set<string> {
  const raw = readConfDir(dir);
  const files = new Map<string, Section[]>();
  for (const [name, text] of raw) files.set(name, parseSections(text));

  const twoOwner = new Set<string>();
  for (const places of definitions(files).values()) {
    const [first] = places;
    if (!first || first.type !== "endpoint") continue;
    if (places.length <= 1) continue;
    if (wanted && !wanted.has(first.id)) continue;
    twoOwner.add(first.id);
  }
  return twoOwner;
}
