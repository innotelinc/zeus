/**
 * The design system, and the two ways a screen drifts off it.
 *
 * `docs/unified-console.md` §4 is the rule: one primitive set, one state
 * vocabulary, and a module that needs something new adds it to the set rather
 * than to itself. The failure mode is silent — a screen grows its own panel,
 * its own heading, its own empty state, and in three months the console reads
 * as six apps again. Nothing throws; it just looks unlike the rest.
 *
 * Three drifts are cheap to introduce and invisible in review, so they are
 * asserted here against the source:
 *
 *   1. **A raw page heading.** A screen that draws its own `<h1 className=
 *      "text-2xl …">` instead of `PageHeader` is how the six UIs looked
 *      different in the first place.
 *   2. **A hand-rolled empty state.** An operator reading "no data" with no
 *      next step cannot tell a quiet system from a broken one; that is the
 *      whole reason `EmptyState` takes a description and an action.
 *   3. **A screen that composes neither the primitives nor a section.** A route
 *      that renders its own markup end-to-end has opted out of the system.
 *
 * The guard is deliberately source-level: `scripts/ts-probe.mjs` transpiles
 * `.ts`, not `.tsx`, and there is no JSX test runner here — so the assertions
 * read text. That is honest for what they hold: presence, not rendering.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(REPO, rel), "utf8");

/** Every file under `dir` (repo-relative), recursively. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(join(REPO, dir))) {
    const rel = join(dir, entry);
    if (statSync(join(REPO, rel)).isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}

const DASHBOARD_DIRS = ["src/app/dashboard", "src/components/dashboard"];
const dashboardFiles = () => DASHBOARD_DIRS.flatMap((dir) => walk(dir));

/**
 * A raw page heading: `<h1 className="text-2xl …">`.
 *
 * Scanned as a substring, not a regex on the whole tag, because the class list
 * after `text-2xl` is exactly what varies between screens — and varying it per
 * screen is the drift being prevented.
 */
const RAW_HEADING = '<h1 className="text-2xl';

/**
 * The empty-state container the console started with: a rounded, dashed-or-
 * bordered panel with the copy centred and no action.
 */
const RAW_EMPTY_STATE = "rounded-3xl border border-white/[0.06] bg-white/[0.02] p-12";

describe("the design system", () => {
  it("exports the primitive set every screen composes", () => {
    const index = read("src/components/ui/index.ts");
    for (const name of ["Card", "CardHeader", "Badge", "Stat", "EmptyState", "PageHeader", "Button", "Tabs"]) {
      assert.match(
        index,
        new RegExp(`\\b${name}\\b`),
        `${name} is missing from src/components/ui — the screens behind it will drift`,
      );
    }
  });

  it("is the only source of a page heading", () => {
    const offenders = dashboardFiles().filter((file) => read(file).includes(RAW_HEADING));
    assert.deepEqual(
      offenders,
      [],
      `these screens draw their own heading instead of PageHeader:\n${offenders.join("\n")}`,
    );
  });

  it("is the only source of an empty state", () => {
    const offenders = dashboardFiles().filter((file) => read(file).includes(RAW_EMPTY_STATE));
    assert.deepEqual(
      offenders,
      [],
      `these screens roll their own empty state instead of EmptyState:\n${offenders.join("\n")}`,
    );
  });
});

describe("every dashboard screen", () => {
  const pages = () =>
    walk("src/app/dashboard").filter((file) => file.endsWith("page.tsx")).sort();

  it("composes the primitives, or delegates to a section that does", () => {
    const offenders = pages().filter((page) => {
      const source = read(page);
      const composesPrimitives = source.includes("@/components/ui");
      const delegates = source.includes("@/components/dashboard/");
      return !composesPrimitives && !delegates;
    });
    assert.deepEqual(
      offenders,
      [],
      `these pages neither compose the primitives nor render a dashboard section:\n${offenders.join("\n")}`,
    );
  });

  it("names a real file for each route the registry owns", () => {
    // The registry's owned hrefs are what the rail navigates to; a route that
    // does not exist is a 404 an operator finds by clicking. Read the surface
    // list out of console.ts as text (the module reads env at import, and this
    // test wants the routes, not the environment).
    const consoleSource = read("src/lib/console.ts");
    const hrefs = [...consoleSource.matchAll(/href:\s*"(\/dashboard[^"]*)"/g)].map((m) => m[1]);
    assert.ok(hrefs.length > 0, "no owned routes found in the console registry");
    const routes = new Set(
      pages().map((page) => "/" + relative("src/app", page).replace(/\/page\.tsx$/, "")),
    );
    for (const href of hrefs) {
      assert.ok(routes.has(href), `the registry points at ${href}, which has no page.tsx`);
    }
  });
});
